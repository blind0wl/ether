package plex

import (
	"net/http"
	"strings"
	"testing"
)

func TestOwnerEntitlementsReachSharedClients(t *testing.T) {
	active := true
	features := []string{"pass", "remote-watch-pass"}
	f := newFixture(func(d *Deps) {
		d.OwnerSubscription = func() (bool, []string) { return active, features }
	})
	defer f.srv.Close()
	check := func(wantActive, wantFeatures string) {
		t.Helper()
		for _, path := range []string{"/", "/media/providers", "/myplex/account"} {
			rec := f.request(t, http.MethodGet, path, map[string]string{"X-Plex-Token": friendToken})
			if rec.Code != http.StatusOK {
				t.Fatalf("%s: status %d", path, rec.Code)
			}
			activeAttr, featuresAttr := "myPlexSubscription", "ownerFeatures"
			if path == "/myplex/account" {
				activeAttr, featuresAttr = "subscriptionActive", "subscriptionFeatures"
			}
			for _, attr := range []string{activeAttr + `="` + wantActive + `"`, featuresAttr + `="` + wantFeatures + `"`} {
				// The account endpoint omits the empty feature list.
				if wantFeatures == "" && strings.HasPrefix(attr, featuresAttr) && !strings.Contains(rec.Body.String(), featuresAttr+`="`) {
					continue
				}
				if !strings.Contains(rec.Body.String(), attr) {
					t.Fatalf("%s missing %s: %s", path, attr, rec.Body.String())
				}
			}
		}
	}
	check("1", "pass,remote-watch-pass")
	// Changes after startup, including revocation, must reach clients.
	active, features = false, nil
	check("0", "")
}
