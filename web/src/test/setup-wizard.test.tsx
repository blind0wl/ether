import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createFakeServer } from "../mock/server";
import Setup, { canAdvance } from "../pages/Setup";
import type { Indexer, UsenetProvider } from "../lib/types";
import { api } from "../lib/api";
import { calls, renderApp } from "./harness";

const provider: UsenetProvider = {
  id: "p1",
  name: "Main",
  host: "news.example.com",
  port: 563,
  tls: true,
  username: "u",
  password: "pw",
  connections: 20,
  priority: 0,
  backfill: false,
  enabled: true,
};
const indexer: Indexer = {
  id: "i1",
  name: "Idx",
  url: "https://idx.example.com",
  apiKey: "k",
  dailyLimit: 0,
  dailyGrabs: 0,
  priority: 0,
  enabled: true,
  movieCategories: null,
  tvCategories: null,
};

describe("canAdvance gating", () => {
  const base = {
    plexDone: false,
    providers: [provider],
    indexers: [indexer],
    providerTests: {},
    indexerTests: {},
    skipped: {},
  };
  it("blocks the Plex step until sign-in completes", () => {
    expect(canAdvance(0, base)).toBe(false);
    expect(canAdvance(0, { ...base, plexDone: true })).toBe(true);
  });
  it("blocks providers until every enabled provider passes its test", () => {
    expect(canAdvance(1, base)).toBe(false);
    expect(canAdvance(1, { ...base, providerTests: { p1: { status: "fail" } } })).toBe(false);
    expect(canAdvance(1, { ...base, providerTests: { p1: { status: "ok" } } })).toBe(true);
    expect(canAdvance(1, { ...base, providers: [{ ...provider, enabled: false }] })).toBe(false);
    expect(
      canAdvance(1, {
        ...base,
        providers: [{ ...provider, host: "" }],
        providerTests: { p1: { status: "ok" } },
      }),
    ).toBe(false);
  });
  it("blocks indexers until tested; the skip escape hatch always passes", () => {
    expect(canAdvance(2, base)).toBe(false);
    expect(canAdvance(2, { ...base, indexerTests: { i1: { status: "ok" } } })).toBe(true);
    expect(canAdvance(0, { ...base, skipped: { 0: true } })).toBe(true);
    expect(canAdvance(1, { ...base, skipped: { 1: true } })).toBe(true);
  });
  it("cache and optional steps never block", () => {
    expect(canAdvance(3, base)).toBe(true);
    expect(canAdvance(4, base)).toBe(true);
  });
});

function renderWizard(configure?: (fake: ReturnType<typeof createFakeServer>) => void) {
  const fake = createFakeServer();
  fake.state.config.setupComplete = false;
  fake.state.config.plex.ownerUsername = "alice";
  configure?.(fake);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && String(input).endsWith("/config")) {
        const config = JSON.parse(String(init.body));
        const fields = [
          ...(config.usenet.providers ?? []).flatMap((p: UsenetProvider, i: number) =>
            p.host.trim() ? [] : [{ field: `usenet.providers[${i}].host`, message: "is required" }],
          ),
          ...(config.indexers ?? []).flatMap((ix: Indexer, i: number) =>
            ix.url.trim() ? [] : [{ field: `indexers[${i}].url`, message: "is required" }],
          ),
        ];
        if (fields.length)
          return new Response(
            JSON.stringify({
              error: { code: "validation", message: "configuration is invalid", fields },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
      }
      return fake.fetch(input, init);
    }),
  );
  render(
    <MemoryRouter>
      <Setup />
    </MemoryRouter>,
  );
  return fake;
}

describe("setup wizard", () => {
  it("saves a fresh Plex step and a provider without submitting blank future sources", async () => {
    const fake = renderWizard((f) => {
      f.state.config.usenet.providers = [];
      f.state.config.indexers = [];
    });
    await screen.findByText(/Signed in as alice/);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("heading", { name: "Usenet providers" });
    expect(calls(fake, "PUT", "/config")[0]?.body).toMatchObject({
      usenet: { providers: [] },
      indexers: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.change(screen.getByPlaceholderText("news.example.com"), {
      target: { value: provider.host },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Test$/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("heading", { name: "Newznab indexers" });
    expect(fake.state.config.usenet.providers?.[0]?.host).toBe(provider.host);
    expect(fake.state.config.indexers).toEqual([]);
  });

  it("can explicitly skip unused sources without creating invalid rows", async () => {
    const fake = renderWizard((f) => {
      f.state.config.usenet.providers = [];
      f.state.config.indexers = [];
    });
    await screen.findByText(/Signed in as alice/);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    for (const heading of ["Usenet providers", "Newznab indexers"]) {
      await screen.findByRole("heading", { name: heading });
      fireEvent.click(screen.getByLabelText(/Skip test for this step/));
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    }
    await screen.findByRole("heading", { name: "Cache folder and disk budget" });
    expect(fake.state.config.usenet.providers).toEqual([]);
    expect(fake.state.config.indexers).toEqual([]);
  });

  it.each(["provider", "indexer"] as const)(
    "keeps an incomplete %s visible when skipping its test",
    async (kind) => {
      renderWizard((f) => {
        f.state.config.usenet.providers = [];
        f.state.config.indexers = [];
      });
      await screen.findByText(/Signed in as alice/);
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
      await screen.findByRole("heading", { name: "Usenet providers" });
      if (kind === "indexer") {
        fireEvent.click(screen.getByLabelText(/Skip test for this step/));
        fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
        await screen.findByRole("heading", { name: "Newznab indexers" });
      }
      fireEvent.click(screen.getByRole("button", { name: `Add ${kind}` }));
      fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "Keep my draft" } });
      fireEvent.click(screen.getByLabelText(/Skip test for this step/));
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
      expect(await screen.findByText(/is required/)).toBeInTheDocument();
      expect(screen.getAllByRole("textbox")[0]!).toHaveValue("Keep my draft");
    },
  );

  it("clears the pending PIN and preserves newly claimed credentials on the next save", async () => {
    const fake = renderWizard((f) => {
      f.state.config.plex.token = "";
      f.state.config.plex.claimed = false;
      f.state.config.plex.ownerUsername = "";
    });
    await screen.findByRole("button", { name: "Sign in to plex.tv" });
    vi.useFakeTimers();
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.spyOn(api, "pinStart").mockResolvedValue({
      id: "pin",
      code: "ABCD",
      authUrl: "https://example.test/auth",
    });
    const poll = vi.spyOn(api, "pinPoll").mockImplementation(async () => {
      fake.state.config.plex.token = "••••";
      fake.state.config.plex.ownerUsername = "alice";
      return { done: true };
    });
    let finishClaim!: () => void;
    vi.spyOn(api, "claim").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishClaim = () => {
            fake.state.config.plex.claimed = true;
            resolve({ ok: true });
          };
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to plex.tv" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.queryByText(/waiting for approval/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save and continue|Saving/ })).toBeDisabled();
    await act(async () => {
      finishClaim();
    });
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Claim server" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(poll).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    });
    expect(calls(fake, "PUT", "/config")[0]?.body).toMatchObject({
      plex: { token: "••••", claimed: true, ownerUsername: "alice" },
    });
    expect(screen.getByRole("heading", { name: "Usenet providers" })).toBeInTheDocument();
  });

  it("keeps claim failures actionable and refreshes credentials after a retry", async () => {
    const fake = renderWizard((f) => {
      f.state.config.plex.claimed = false;
    });
    const claim = vi
      .spyOn(api, "claim")
      .mockRejectedValueOnce(new Error("Plex unavailable"))
      .mockImplementationOnce(async () => {
        fake.state.config.plex.claimed = true;
        return { ok: true };
      });
    const retry = await screen.findByRole("button", { name: "Claim server" });
    fireEvent.click(retry);
    expect((await screen.findAllByText(/Plex unavailable/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Claim server" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Claim server" })).not.toBeInTheDocument(),
    );
    expect(claim).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
  });

  it("walks from a claimed Plex step to providers and gates on the provider test", async () => {
    const fake = renderWizard();
    expect(await screen.findByText(/Signed in as alice/)).toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Save and continue" });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    expect(await screen.findByRole("heading", { name: "Usenet providers" })).toBeInTheDocument();
    expect(calls(fake, "PUT", "/config")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Save and continue" })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: /^Test$/ })[0]!);
    await waitFor(() => expect(screen.getAllByText(/OK · \d+ ms/).length).toBeGreaterThan(0));
    // Both seeded providers must pass before continuing.
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: /^Test$/ })[1]!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled(),
    );
  });

  it("the skip-test checkbox unblocks an untested step", async () => {
    renderWizard();
    await screen.findByText(/Signed in as alice/);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await screen.findByRole("heading", { name: "Usenet providers" });
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Skip test for this step/));
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeEnabled();
  });

  it("an unfinished setup sends the owner to the wizard instead of Home", async () => {
    renderApp("/", { bootstrap: { setupComplete: false } });
    expect(await screen.findByRole("heading", { name: "Set up Ether" })).toBeInTheDocument();
    expect(screen.getAllByText("Finish setup").length).toBeGreaterThan(0);
  });
});
