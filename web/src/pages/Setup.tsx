import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Input,
  SearchSelect,
  Slider,
  Spinner,
  Switch,
  WizardLayout,
  cn,
} from "@braedonsaunders/appkit-ui";
import { Check, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAppOptional } from "../app-context";
import { EtherMark } from "../components/brand";
import { ErrorPanel, MutationError } from "../components/feedback";
import { Field, NumberInput, SecretInput, TestButton, type TestState } from "../components/fields";
import {
  findProvider,
  ModelPicker,
  providerOptions,
  useLLMProviders,
  withProvider,
} from "../components/llm";
import { api, newId } from "../lib/api";
import { formatBytes } from "../lib/format";
import type { DiskInfo, EtherConfig, Indexer, UsenetProvider } from "../lib/types";

const STEPS = [
  { title: "Plex", heading: "Sign in to plex.tv and claim this server" },
  { title: "Usenet", heading: "Usenet providers" },
  { title: "Indexers", heading: "Newznab indexers" },
  { title: "Cache", heading: "Cache folder and disk budget" },
  { title: "Extras", heading: "Optional integrations" },
];
const GIB = 1024 ** 3;

function blankProvider(): UsenetProvider {
  return {
    id: newId("prov"),
    name: "",
    host: "",
    port: 563,
    tls: true,
    username: "",
    password: "",
    connections: 20,
    priority: 0,
    backfill: false,
    enabled: true,
  };
}
function blankIndexer(): Indexer {
  return {
    id: newId("idx"),
    name: "",
    url: "",
    apiKey: "",
    dailyLimit: 0,
    dailyGrabs: 0,
    priority: 0,
    enabled: true,
    movieCategories: null,
    tvCategories: null,
  };
}

/** Whether a wizard step may be left: required steps must be complete and tested (or explicitly skipped). */
export function canAdvance(
  step: number,
  opts: {
    plexDone: boolean;
    providers: UsenetProvider[];
    indexers: Indexer[];
    providerTests: Record<string, TestState>;
    indexerTests: Record<string, TestState>;
    skipped: Record<number, boolean>;
  },
): boolean {
  if (opts.skipped[step]) return true;
  switch (step) {
    case 0:
      return opts.plexDone;
    case 1: {
      const enabled = opts.providers.filter((p) => p.enabled);
      return (
        enabled.length > 0 &&
        enabled.every((p) => p.host.trim() && opts.providerTests[p.id]?.status === "ok")
      );
    }
    case 2: {
      const enabled = opts.indexers.filter((i) => i.enabled);
      return (
        enabled.length > 0 &&
        enabled.every((i) => i.url.trim() && opts.indexerTests[i.id]?.status === "ok")
      );
    }
    default:
      return true;
  }
}

export default function Setup() {
  const navigate = useNavigate();
  const app = useAppOptional();
  const [cfg, setCfg] = useState<EtherConfig | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [providerTests, setProviderTests] = useState<Record<string, TestState>>({});
  const [indexerTests, setIndexerTests] = useState<Record<string, TestState>>({});
  const [optTests, setOptTests] = useState<Record<string, TestState>>({});
  const [pin, setPin] = useState<{ id: string; code: string; authUrl: string } | null>(null);
  const [pinDone, setPinDone] = useState(false);
  const [claimMsg, setClaimMsg] = useState("");
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(() => {
    api
      .getConfig()
      .then((c) => {
        setCfg(c);
        setPinDone(Boolean(c.plex.token));
        setLoadError(null);
      })
      .catch(setLoadError);
  }, []);
  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [load]);

  const refreshDisk = useCallback((path: string) => {
    api
      .disk(path)
      .then(setDisk)
      .catch(() => setDisk(null));
  }, []);
  useEffect(() => {
    if (step === 3 && cfg) refreshDisk(cfg.cache.dir);
  }, [step, cfg?.cache.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  const claimServer = async () => {
    setSaving(true);
    setError(null);
    try {
      try {
        await api.claim();
        setClaimMsg("Server claimed to your Plex account.");
      } catch (e) {
        setClaimMsg(`Signed in, but claiming failed: ${(e as Error).message}`);
      }
      // PIN approval and claiming update the server, not the wizard's draft.
      // Refresh only Plex so the next full-config save retains those credentials.
      const { plex } = await api.getConfig();
      setCfg((c) => (c ? { ...c, plex } : c));
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const startPin = async () => {
    setError(null);
    try {
      const p = await api.pinStart();
      setPin(p);
      window.open(p.authUrl, "_blank", "noopener,noreferrer");
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const { done } = await api.pinPoll(p.id);
          if (!done) return;
          if (pollRef.current) window.clearInterval(pollRef.current);
          setPin(null);
          setPinDone(true);
          setClaimMsg("Signed in. Claiming this server…");
          await claimServer();
        } catch {
          /* keep polling */
        }
      }, 2000);
    } catch (e) {
      setError(e);
    }
  };

  const runTest = async (
    kind: "provider" | "indexer" | "opt",
    key: string,
    fn: () => Promise<{ ok: boolean; error?: string; durationMs: number }>,
  ) => {
    const setMap =
      kind === "provider" ? setProviderTests : kind === "indexer" ? setIndexerTests : setOptTests;
    setMap((m) => ({ ...m, [key]: { status: "running" } }));
    try {
      const r = await fn();
      setMap((m) => ({
        ...m,
        [key]: r.ok
          ? { status: "ok", durationMs: r.durationMs }
          : { status: "fail", message: r.error ?? "failed" },
      }));
    } catch (e) {
      setMap((m) => ({ ...m, [key]: { status: "fail", message: (e as Error).message } }));
    }
  };

  const advanceOk = useMemo(
    () =>
      cfg
        ? canAdvance(step, {
            plexDone: Boolean(cfg.plex.claimed && cfg.plex.token),
            providers: cfg.usenet.providers ?? [],
            indexers: cfg.indexers ?? [],
            providerTests,
            indexerTests,
            skipped,
          })
        : false,
    [cfg, step, providerTests, indexerTests, skipped],
  );

  if (loadError && !cfg)
    return (
      <div className="p-6">
        <ErrorPanel error={loadError} onRetry={load} />
      </div>
    );
  if (!cfg)
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner size={22} label="Loading configuration" />
      </div>
    );

  const providers = cfg.usenet.providers ?? [];
  const indexers = cfg.indexers ?? [];
  const setProviders = (list: UsenetProvider[]) =>
    setCfg({ ...cfg, usenet: { providers: list.map((p, i) => ({ ...p, priority: i })) } });
  const setIndexers = (list: Indexer[]) =>
    setCfg({ ...cfg, indexers: list.map((x, i) => ({ ...x, priority: i })) });
  const patchProvider = (i: number, p: Partial<UsenetProvider>) =>
    setProviders(providers.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const patchIndexer = (i: number, p: Partial<Indexer>) =>
    setIndexers(indexers.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const next = async () => {
    setSaving(true);
    setError(null);
    try {
      setCfg(await api.putConfig(cfg));
      if (step < STEPS.length - 1) setStep(step + 1);
      else {
        await api.setupComplete(Object.values(skipped).some(Boolean));
        await app?.reloadBoot();
        navigate("/");
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const plexSigned = pinDone || Boolean(cfg.plex.claimed && cfg.plex.token);
  const maxBudget = disk ? Math.max(GIB, disk.freeBytes + cfg.cache.budgetBytes) : 500 * GIB;

  return (
    <WizardLayout
      header={
        <div>
          <div className="flex items-center gap-3">
            <EtherMark size={32} />
            <div>
              <h1 className="text-lg font-semibold text-fg">Set up Ether</h1>
              <p className="text-sm text-fg-muted">
                Five quick steps and your Plex apps will find Ether like any other server.
              </p>
            </div>
          </div>
          <ol className="mt-4 flex gap-1.5" aria-label="Setup progress">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex-1">
                <button
                  type="button"
                  disabled={i > step}
                  onClick={() => setStep(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={cn(
                    "w-full text-left disabled:cursor-not-allowed",
                    i <= step ? "text-fg" : "text-fg-subtle",
                  )}
                >
                  <span
                    className={cn(
                      "block h-1 rounded-full",
                      i < step ? "bg-primary" : i === step ? "bg-primary/60" : "bg-border",
                    )}
                  />
                  <span className="mt-1.5 flex items-center gap-1 text-xs font-medium">
                    {i < step ? (
                      <Check size={12} className="text-primary" />
                    ) : (
                      <span className="tabular-nums">{i + 1}.</span>
                    )}{" "}
                    {s.title}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" disabled={step === 0 || saving} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          {step < 3 ? (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <Checkbox
                checked={Boolean(skipped[step])}
                onChange={(e) => setSkipped({ ...skipped, [step]: e.currentTarget.checked })}
              />
              Skip test for this step (advanced)
            </label>
          ) : null}
          <span className="flex-1" />
          {!advanceOk && step < 3 ? (
            <span className="hidden text-xs text-fg-muted sm:inline">
              Complete and test this step to continue.
            </span>
          ) : null}
          <Button disabled={!advanceOk || saving} onClick={() => void next()}>
            {saving ? "Saving…" : step === STEPS.length - 1 ? "Finish setup" : "Save and continue"}
          </Button>
        </div>
      }
    >
      {step === 0 ? (
        <Alert>
          <AlertDescription>
            Adding a node to an existing cluster?{" "}
            <Button variant="link" onClick={() => navigate("/cluster")}>
              Join a cluster instead
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <h2 className="text-base font-semibold text-fg">{STEPS[step]!.heading}</h2>
      <MutationError error={error} />

      {step === 0 ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Ether registers with your Plex account like a fresh Plex Media Server, so the official
            Plex apps can find it.
          </p>
          {plexSigned ? (
            <Alert variant="success">
              <AlertDescription>
                Signed in{cfg.plex.ownerUsername ? ` as ${cfg.plex.ownerUsername}` : ""}. {claimMsg}
              </AlertDescription>
            </Alert>
          ) : null}
          {pin ? (
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-sm text-fg">Enter this code at plex.tv:</p>
              <p className="my-2 font-mono text-3xl font-bold tracking-[0.3em] text-fg">
                {pin.code}
              </p>
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                <a
                  href={pin.authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  Open plex.tv sign-in <ExternalLink size={13} />
                </a>
                · waiting for approval <Spinner size={13} label="Waiting" />
              </p>
            </div>
          ) : !plexSigned ? (
            <Button disabled={saving} onClick={() => void startPin()}>
              Sign in to plex.tv
            </Button>
          ) : null}
          {claimMsg && !cfg.plex.claimed ? (
            <p className="text-sm text-fg-muted">{claimMsg}</p>
          ) : null}
          {plexSigned && !cfg.plex.claimed ? (
            <Button variant="outline" disabled={saving} onClick={() => void claimServer()}>
              Claim server
            </Button>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Add at least one provider and test it. Block accounts can be marked as backfill.
          </p>
          {providers.map((p, i) => (
            <fieldset key={p.id || i} className="rounded-xl border border-border bg-surface p-4">
              <legend className="px-1 text-sm font-medium text-fg">
                {p.name || `Provider ${i + 1}`}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={p.name}
                    onChange={(e) => patchProvider(i, { name: e.currentTarget.value })}
                  />
                </Field>
                <Field label="Host">
                  <Input
                    value={p.host}
                    placeholder="news.example.com"
                    onChange={(e) => patchProvider(i, { host: e.currentTarget.value })}
                  />
                </Field>
                <Field label="Port">
                  <NumberInput
                    aria-label="Port"
                    value={p.port}
                    min={1}
                    max={65535}
                    onChange={(n) => patchProvider(i, { port: n })}
                  />
                </Field>
                <Field label="Connections">
                  <NumberInput
                    aria-label="Connections"
                    value={p.connections}
                    min={0}
                    max={500}
                    onChange={(n) => patchProvider(i, { connections: n })}
                  />
                </Field>
                <Field label="Username">
                  <Input
                    value={p.username}
                    autoComplete="username"
                    onChange={(e) => patchProvider(i, { username: e.currentTarget.value })}
                  />
                </Field>
                <Field label="Password">
                  <SecretInput
                    ariaLabel="Password"
                    value={p.password}
                    onChange={(v) => patchProvider(i, { password: v })}
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-5 text-sm text-fg">
                <label className="flex items-center gap-2">
                  <Switch
                    checked={p.tls}
                    onChange={(e) => patchProvider(i, { tls: e.currentTarget.checked })}
                  />{" "}
                  SSL / TLS
                </label>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={p.backfill}
                    onChange={(e) => patchProvider(i, { backfill: e.currentTarget.checked })}
                  />{" "}
                  Backfill only
                </label>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={p.enabled}
                    onChange={(e) => patchProvider(i, { enabled: e.currentTarget.checked })}
                  />{" "}
                  Enabled
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <TestButton
                  state={providerTests[p.id] ?? { status: "idle" }}
                  onTest={() => void runTest("provider", p.id, () => api.testUsenet(p))}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setProviders(providers.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} /> Remove
                </Button>
              </div>
            </fieldset>
          ))}
          <Button variant="outline" onClick={() => setProviders([...providers, blankProvider()])}>
            <Plus size={15} /> Add provider
          </Button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">
            Add at least one indexer. Ether handles service limits automatically.
          </p>
          {indexers.map((ix, i) => (
            <fieldset key={ix.id || i} className="rounded-xl border border-border bg-surface p-4">
              <legend className="px-1 text-sm font-medium text-fg">
                {ix.name || `Indexer ${i + 1}`}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <Input
                    value={ix.name}
                    onChange={(e) => patchIndexer(i, { name: e.currentTarget.value })}
                  />
                </Field>
                <Field label="Base URL" hint="/api is added automatically.">
                  <Input
                    value={ix.url}
                    placeholder="https://indexer.example.com"
                    onChange={(e) => patchIndexer(i, { url: e.currentTarget.value })}
                  />
                </Field>
                <Field label="API key">
                  <SecretInput
                    ariaLabel="API key"
                    value={ix.apiKey}
                    onChange={(v) => patchIndexer(i, { apiKey: v })}
                  />
                </Field>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-fg">
                  <Switch
                    checked={ix.enabled}
                    onChange={(e) => patchIndexer(i, { enabled: e.currentTarget.checked })}
                  />{" "}
                  Enabled
                </label>
                <span className="flex items-center gap-2">
                  <TestButton
                    state={indexerTests[ix.id] ?? { status: "idle" }}
                    onTest={() => void runTest("indexer", ix.id, () => api.testIndexer(ix))}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIndexers(indexers.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={14} /> Remove
                  </Button>
                </span>
              </div>
            </fieldset>
          ))}
          <Button variant="outline" onClick={() => setIndexers([...indexers, blankIndexer()])}>
            <Plus size={15} /> Add indexer
          </Button>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-5 rounded-xl border border-border bg-surface p-4">
          <Field label="Cache folder">
            <div className="flex gap-2">
              <Input
                value={cfg.cache.dir}
                onChange={(e) =>
                  setCfg({ ...cfg, cache: { ...cfg.cache, dir: e.currentTarget.value } })
                }
              />
              <Button variant="outline" onClick={() => refreshDisk(cfg.cache.dir)}>
                Check space
              </Button>
            </div>
          </Field>
          {disk ? (
            <p className="text-sm text-fg-muted">
              {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)} on this disk.
            </p>
          ) : null}
          <Field
            label={`Disk budget: ${formatBytes(cfg.cache.budgetBytes)}`}
            hint="Older segments are evicted when the cache reaches this size."
          >
            <div className="flex items-center gap-3">
              <Slider
                min={GIB}
                max={maxBudget}
                step={GIB}
                value={Math.min(cfg.cache.budgetBytes, maxBudget)}
                aria-label="Disk budget"
                className="flex-1"
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    cache: { ...cfg.cache, budgetBytes: e.currentTarget.valueAsNumber },
                  })
                }
              />
              <NumberInput
                aria-label="Disk budget in GiB"
                className="w-24"
                value={Math.round(cfg.cache.budgetBytes / GIB)}
                min={1}
                onChange={(n) =>
                  setCfg({
                    ...cfg,
                    cache: { ...cfg.cache, budgetBytes: Math.max(1, Math.round(n)) * GIB },
                  })
                }
              />
              <span className="text-sm text-fg-muted">GiB</span>
            </div>
          </Field>
          <div className="flex flex-wrap gap-5 text-sm text-fg">
            <label className="flex items-center gap-2">
              <Switch
                checked={cfg.cache.prefetchNextEpisode}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    cache: { ...cfg.cache, prefetchNextEpisode: e.currentTarget.checked },
                  })
                }
              />{" "}
              Prefetch the next episode
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={cfg.cache.keepInProgressWarm}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    cache: { ...cfg.cache, keepInProgressWarm: e.currentTarget.checked },
                  })
                }
              />{" "}
              Keep in-progress titles warm
            </label>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-muted">All of these can be set up later in Settings.</p>
          <div className="grid gap-4 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2">
            <Field
              label="Your TMDB API key"
              hint="Enter your personal TMDB v3 API key or v4 read token."
            >
              <div className="space-y-2">
                <SecretInput
                  ariaLabel="TMDB API key"
                  value={cfg.catalog.tmdbKey}
                  onChange={(v) => setCfg({ ...cfg, catalog: { ...cfg.catalog, tmdbKey: v } })}
                />
                <TestButton
                  state={optTests.tmdb ?? { status: "idle" }}
                  onTest={() =>
                    void runTest("opt", "tmdb", () => api.testTMDB(cfg.catalog.tmdbKey))
                  }
                />
              </div>
            </Field>
            <Field label="Trakt client ID">
              <Input
                value={cfg.trakt.clientId}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    trakt: {
                      ...cfg.trakt,
                      clientId: e.currentTarget.value,
                      enabled: Boolean(e.currentTarget.value),
                    },
                  })
                }
              />
            </Field>
            <Field label="OpenSubtitles API key">
              <SecretInput
                ariaLabel="OpenSubtitles API key"
                value={cfg.openSubtitles.apiKey}
                onChange={(v) =>
                  setCfg({
                    ...cfg,
                    openSubtitles: { ...cfg.openSubtitles, apiKey: v, enabled: Boolean(v) },
                  })
                }
              />
            </Field>
            <LanguageModelFields
              llm={cfg.llm}
              onChange={(llm) => setCfg({ ...cfg, llm })}
              test={
                <TestButton
                  state={optTests.llm ?? { status: "idle" }}
                  onTest={() => void runTest("opt", "llm", () => api.testLLM(cfg.llm))}
                />
              }
            />
            <label className="flex items-center gap-2 self-end text-sm text-fg">
              <Switch
                checked={cfg.resolver.allowCam}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    resolver: { ...cfg.resolver, allowCam: e.currentTarget.checked },
                  })
                }
              />{" "}
              Allow CAM / telesync releases
            </label>
          </div>
          <Alert variant="info">
            <AlertDescription>
              Finishing setup locks this admin page to your Plex account. You can reopen setup later
              from Settings.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
    </WizardLayout>
  );
}

/** Wizard step 4's language model: provider, key or endpoint, then model. */
function LanguageModelFields({
  llm,
  onChange,
  test,
}: {
  llm: EtherConfig["llm"];
  onChange: (llm: EtherConfig["llm"]) => void;
  test: ReactNode;
}) {
  const { providers } = useLLMProviders();
  const provider = findProvider(providers, llm.provider);
  return (
    <>
      <Field label="Language model provider" hint="Powers “Describe it” and themed Home rows.">
        <SearchSelect
          value={llm.provider}
          onChange={(id) => onChange({ ...withProvider(llm, undefined, id), enabled: false })}
          options={providerOptions(providers)}
          ariaLabel="Language model provider"
          placeholder={providers ? "None" : "Loading…"}
          searchable
        />
      </Field>
      {provider?.local ? (
        <Field label="Language model endpoint" htmlFor="setup-llm-url">
          <Input
            id="setup-llm-url"
            value={llm.baseUrl}
            placeholder={provider.baseUrl || "https://example.com/v1"}
            onChange={(e) => onChange({ ...llm, baseUrl: e.currentTarget.value })}
            spellCheck={false}
          />
        </Field>
      ) : null}
      {provider ? (
        <Field label="Language model API key">
          <SecretInput
            ariaLabel="Language model API key"
            value={llm.apiKey}
            placeholder={provider.keyHint}
            onChange={(apiKey) => onChange({ ...llm, apiKey })}
          />
        </Field>
      ) : null}
      {provider ? (
        <Field label="Language model" hint={provider.modelHint}>
          <div className="space-y-2">
            <ModelPicker
              cfg={llm}
              provider={provider}
              value={llm.model}
              onChange={(model) => onChange({ ...llm, model, enabled: Boolean(model) })}
            />
            {test}
          </div>
        </Field>
      ) : null}
    </>
  );
}
