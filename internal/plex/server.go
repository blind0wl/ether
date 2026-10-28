// Package plex is Ether's Plex Media Server front end: the HTTP API that
// official Plex apps (Web, iOS, Apple TV, Android, TVs) talk to. Everything
// behind it is reached through internal/core interfaces.
package plex

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/braedonsaunders/ether/internal/clusterbus"
	"github.com/braedonsaunders/ether/internal/config"
	"github.com/braedonsaunders/ether/internal/core"
	"github.com/braedonsaunders/ether/internal/episodeorder"
	"github.com/braedonsaunders/ether/internal/livetv"
	"github.com/braedonsaunders/ether/internal/plexguid"
)

// DefaultPMSVersion is reported when Identity.Version is empty. Clients gate
// features on the server version, so it must look like a current PMS build.
const DefaultPMSVersion = "1.43.4.10903-e5521bd8c"

// Identity is how the server presents itself. Empty fields fall back to the
// config snapshot (friendly name, machine identifier) or sensible defaults.
type Identity struct {
	MachineIdentifier string
	FriendlyName      string
	Version           string // PMS-style version string
	Platform          string // "MacOSX", "Windows", "Linux"
	PlatformVersion   string
	// MyPlexSubscription reports whether the owner has Plex Pass; Ether
	// reports this honestly from plex.tv.
	MyPlexSubscription bool
	OwnerFeatures      []string
}

// Hooks are optional callbacks into other components. They run on their own
// goroutine and must be safe for concurrent use.
type Hooks struct {
	// OnTimeline is called for every timeline update (prefetch uses it).
	OnTimeline func(user *core.User, key core.RatingKey, offset, duration time.Duration, state string)
	// OnScrobble is called when a user marks an item watched.
	OnScrobble func(user *core.User, key core.RatingKey)
}

// Section is a library section exposed to clients.
type Section struct {
	ID       int
	Type     core.MediaType // movie or show
	Title    string
	UUID     string // stable; derived from the machine identifier when empty
	Language string
}

// SessionToucher is optionally implemented by core.Playback to keep a play
// session alive on timeline updates.
type SessionToucher interface {
	Touch(sessionID string)
}

// Deps are the server's dependencies. Catalog, State, Auth and Playback are
// required; the rest degrade gracefully when nil.
type Deps struct {
	FilterAvailable     func(context.Context, []core.Title) []core.Title
	PrioritizeAvailable func(context.Context, []core.Title) []core.Title
	EpisodeOrder        *episodeorder.Service
	PlexGUID            *plexguid.Service
	Discovery           *DiscoveryFeatures
	LiveTV              *livetv.Service
	AccessPolicy        AccessPolicy
	Catalog             core.Catalog
	Collections         core.Collections
	VibeSearch          core.VibeSearcher
	Recommender         core.Recommender
	State               core.State
	Playlists           core.Playlists
	Auth                core.Auth
	Playback            core.Playback
	Transcoder          core.Transcoder
	// Variants lists distinct release versions for "Play Version" detail
	// pages (optional: without it, detail pages stay single-Media).
	Variants core.VariantResolver
	// Downloads remuxes resolved sources to temp MP4s for the Download
	// Queue API; nil disables downloads (allowSync stays "0").
	Downloads        core.DownloadRemuxer
	TrackPreferences TrackPreferences
	Markers          MarkerProvider
	Subtitles        SubtitleSource
	Extras           ExtrasProvider
	Trickplay        core.TrickplayProvider

	// Config returns the current settings snapshot.
	Config func() config.Config
	// OwnerSubscription returns the current entitlement snapshot from plex.tv.
	OwnerSubscription func() (active bool, features []string)
	// ImageURL builds TMDB image URLs; defaults to image.tmdb.org.
	ImageURL core.ImageURLFunc
	Logger   *slog.Logger
	Identity Identity
	Hooks    Hooks

	// Sections overrides the default Movies (1) and TV Shows (2) sections.
	Sections []Section
	// HTTPClient fetches artwork for the image proxy; defaults to a client
	// with a 20 s timeout.
	HTTPClient *http.Client
	// ImageCacheBytes bounds the in-memory artwork cache (default 128 MiB).
	ImageCacheBytes int64
	// DB persists derived artwork data (UltraBlurColors) in plex_* tables.
	// Optional: without it, colours are kept in memory only.
	DB *sql.DB
	// DisableEnrichment turns off the background title-detail and
	// UltraBlurColors work (the spike test library has nothing to fetch).
	DisableEnrichment bool
	// Cluster, when set (clustered nodes only; requires DB), shares play
	// sessions, play queues, terminations and notifications with the other
	// nodes. Nil keeps everything in this process.
	Cluster clusterbus.Node
	// SessionHeartbeat is how often a clustered node refreshes its shared
	// play sessions (default 10s).
	SessionHeartbeat time.Duration
	// Now is the clock (tests).
	Now func() time.Time
}

// Server is the PMS API handler. It is an http.Handler; call Close on
// shutdown to stop background work and notification streams.
type Server struct {
	d      Deps
	log    *slog.Logger
	router chi.Router

	sections []Section

	images           *imageCache
	streams          *streamRegistry
	variantIDs       *variantIDRegistry
	renderedVariants *renderedVariants
	downloads        *downloadStore
	queues           *playQueueStore
	sessions         *sessionTracker
	transcodes       *transcodeTable
	extraPlay        *extraPlayStore
	selections       *selectionStore
	notifier         *notifier
	facets           *facetCache
	cl               *clusterState // nil on a standalone server

	// Background enrichment (nil when disabled).
	titles    *titleCache
	ultra     *ultraBlurCache
	titleJobs *bgQueue
	blurJobs  *bgQueue

	// Owner stream kills, delivered on the client's next timeline; the
	// janitor drops those whose client never reports again.
	termMu sync.Mutex
	terms  map[string]termination

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	once   sync.Once
}

// NewServer builds the PMS API handler.
func NewServer(d Deps) *Server {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	if d.Config == nil {
		d.Config = func() config.Config { return config.Config{} }
	}
	if d.ImageURL == nil {
		d.ImageURL = func(path, size string) string { return "https://image.tmdb.org/t/p/" + size + path }
	}
	if d.HTTPClient == nil {
		d.HTTPClient = &http.Client{Timeout: 20 * time.Second}
	}
	if d.ImageCacheBytes <= 0 {
		d.ImageCacheBytes = 128 << 20
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{
		d:                d,
		log:              d.Logger.With("component", "plex"),
		images:           newImageCache(d.ImageCacheBytes, d.HTTPClient),
		streams:          newStreamRegistry(),
		variantIDs:       newVariantIDRegistry(d.DB),
		renderedVariants: newRenderedVariants(),
		downloads:        newDownloadStore(),
		queues:           newPlayQueueStore(),
		sessions:         newSessionTracker(),
		transcodes:       newTranscodeTable(),
		extraPlay:        newExtraPlayStore(),
		selections:       newSelectionStore(),
		notifier:         newNotifier(),
		facets:           newFacetCache(),
		ctx:              ctx,
		cancel:           cancel,
	}
	s.sections = s.buildSections()
	s.queues.now = d.Now
	if d.Cluster != nil && d.DB != nil {
		s.cl = newClusterState(s, d.DB, d.Cluster)
		s.queues.cl = s.cl
	}
	if !d.DisableEnrichment && d.Catalog != nil {
		s.titleJobs = newBGQueue(ctx, &s.wg, titleFetchWorkers, titleFetchQueueLen)
		s.blurJobs = newBGQueue(ctx, &s.wg, ultraBlurWorkers, ultraBlurQueueLen)
		s.titles = newTitleCache(s.titleJobs, s.now, s.log, d.Catalog.Get)
		s.ultra = newUltraBlurCache(d.DB, s.blurJobs, s.now, s.log, s.computeUltraBlur)
	}
	s.router = s.routes()
	s.wg.Add(1)
	go s.janitor()
	if s.cl != nil {
		s.cl.start()
	}
	return s
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.router.ServeHTTP(w, r) }

// Close stops background goroutines and disconnects notification clients.
func (s *Server) Close() error {
	s.once.Do(func() {
		s.releaseAllDownloads()
		s.cancel()
		if closer, ok := s.d.Trickplay.(io.Closer); ok {
			_ = closer.Close()
		}
		s.notifier.close()
		s.wg.Wait()
		if s.cl != nil {
			s.cl.close()
		}
	})
	return nil
}

func (s *Server) now() time.Time { return s.d.Now() }

func (s *Server) cfg() config.Config { return s.d.Config() }

// identity resolves the effective identity.
func (s *Server) identity() Identity {
	id := s.d.Identity
	if s.d.OwnerSubscription != nil {
		id.MyPlexSubscription, id.OwnerFeatures = s.d.OwnerSubscription()
	}
	c := s.cfg()
	if id.MachineIdentifier == "" {
		id.MachineIdentifier = c.Server.MachineIdentifier
	}
	if id.MachineIdentifier == "" {
		id.MachineIdentifier = "ether"
	}
	if id.FriendlyName == "" {
		id.FriendlyName = c.Server.FriendlyName
	}
	if id.FriendlyName == "" {
		id.FriendlyName = "Ether"
	}
	if c.Plex.CompatibilityVersion != "" {
		id.Version = c.Plex.CompatibilityVersion
	} else if c.Plex.TrackLatestVersion && c.Plex.LatestCompatibilityVersion != "" {
		id.Version = c.Plex.LatestCompatibilityVersion
	}
	if id.Version == "" {
		id.Version = DefaultPMSVersion
	}
	if id.Platform == "" {
		switch runtime.GOOS {
		case "darwin":
			id.Platform = "MacOSX"
		case "windows":
			id.Platform = "Windows"
		default:
			id.Platform = "Linux"
		}
	}
	return id
}

// LibrarySections returns the canonical section identities for account
// registration. The copy prevents publishers from changing local libraries.
func (s *Server) LibrarySections() []Section {
	return append([]Section(nil), s.sections...)
}

func (s *Server) buildSections() []Section {
	secs := s.d.Sections
	if len(secs) == 0 {
		secs = []Section{
			{ID: 1, Type: core.TypeMovie, Title: "Movies"},
			{ID: 2, Type: core.TypeShow, Title: "TV Shows"},
		}
	}
	out := make([]Section, len(secs))
	for i, sec := range secs {
		if sec.Language == "" {
			sec.Language = "en-US"
		}
		if sec.UUID == "" {
			sum := sha1.Sum([]byte(fmt.Sprintf("%s/section/%d", s.identity().MachineIdentifier, sec.ID)))
			h := hex.EncodeToString(sum[:16])
			sec.UUID = h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
		}
		out[i] = sec
	}
	return out
}

// sectionByID returns the section with the given id.
func (s *Server) sectionByID(id int) (Section, bool) {
	for _, sec := range s.sections {
		if sec.ID == id {
			return sec, true
		}
	}
	return Section{}, false
}

// sectionFor returns the section an item of type t lives in.
func (s *Server) sectionFor(t core.MediaType) (Section, bool) {
	want := core.TypeMovie
	switch t {
	case core.TypeShow, core.TypeSeason, core.TypeEpisode:
		want = core.TypeShow
	}
	for _, sec := range s.sections {
		if sec.Type == want {
			return sec, true
		}
	}
	return Section{}, false
}

// userSections lists the sections a user may see.
func (s *Server) userSections(u *core.User) []Section {
	if u == nil || len(u.AllowedSections) == 0 || u.IsOwner {
		return s.sections
	}
	var out []Section
	for _, sec := range s.sections {
		for _, id := range u.AllowedSections {
			if id == sec.ID {
				out = append(out, sec)
				break
			}
		}
	}
	return out
}

func (s *Server) canSeeSection(u *core.User, id int) bool {
	for _, sec := range s.userSections(u) {
		if sec.ID == id {
			return true
		}
	}
	return false
}

// janitor expires idle play queues, sessions and transcode bindings.
func (s *Server) janitor() {
	defer s.wg.Done()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			now := s.now()
			s.expireDownloads(now)
			s.queues.expire(now, 6*time.Hour)
			s.renderedVariants.expire(now, renderedVariantsTTL)
			s.transcodes.expire(now, 2*time.Hour)
			s.extraPlay.expire(now, 2*time.Hour)
			s.expireTerminations(now, terminationTTL)
			expired := s.sessions.expire(now, 2*time.Minute)
			for _, e := range expired {
				s.notifyPlaying(e, "stopped")
			}
			if len(expired) > 0 {
				s.cl.poke()
			}
		}
	}
}

// goHook runs fn on its own goroutine, recovering panics.
func (s *Server) goHook(name string, fn func()) {
	go func() {
		defer func() {
			if v := recover(); v != nil {
				s.log.Error("hook panicked", "hook", name, "panic", v)
			}
		}()
		fn()
	}()
}

func trimSlash(p string) string { return strings.TrimSuffix(p, "/") }

// TranscodeFor returns the running transcode session fed by a playback
// session. Transcode sessions are keyed by the client's session id, so
// playback needs this to move ffmpeg to a new input on mid-stream failover.
func (s *Server) TranscodeFor(playSessionID string) (core.HLSSession, bool) {
	if s.d.Transcoder == nil {
		return nil, false
	}
	for _, id := range s.transcodes.byPlayID(playSessionID) {
		if hs, ok := s.d.Transcoder.Session(id); ok && hs != nil {
			return hs, true
		}
	}
	if s.d.LiveTV != nil {
		return s.d.LiveTV.TranscodeFor(playSessionID)
	}
	return nil, false
}
