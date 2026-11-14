import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  tick: vi.fn(async () => {}),
  loadConfig: vi.fn(),
  server: { listen: vi.fn(), close: vi.fn(), address: () => ({ port: 8787 }) },
  stopWorkers: vi.fn(),
}));
vi.mock("../src/app.js", () => ({ createApplication: () => fixture.server }));
vi.mock("../src/agents.js", () => ({ CompanyAgents: class { tick = fixture.tick; } }));
vi.mock("../src/near.js", () => ({ createLedger: () => ({}), reason: (error: Error) => error.message }));
vi.mock("../src/credentials.js", () => ({ keysExist: () => true, loadKeys: () => ({}) }));
vi.mock("../src/config.js", () => ({ loadConfig: fixture.loadConfig }));
vi.mock("../src/store.js", () => ({ Store: class { log = vi.fn(); } }));
vi.mock("../src/workers.js", () => ({ attachWorkers: () => fixture.stopWorkers }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("contains synchronous config reload failure and resumes accounting next interval", async () => {
  vi.useFakeTimers(); vi.stubEnv("AGENTS", "on"); vi.stubEnv("AGENT_INTERVAL_SECS", "20"); vi.stubEnv("GROWTH", "off"); // growth harness has its own suites
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fixture.loadConfig.mockReturnValueOnce({}).mockImplementationOnce(() => { throw new Error("invalid edited config"); }).mockReturnValue({});
  const previousInt = new Set(process.listeners("SIGINT"));
  const previousTerm = new Set(process.listeners("SIGTERM"));
  try {
    await import("../src/index.js");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(errors).toHaveBeenCalledWith("[agents] invalid edited config");
    expect(fixture.tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fixture.tick).toHaveBeenCalledOnce();
  } finally {
    for (const listener of process.listeners("SIGTERM")) if (!previousTerm.has(listener)) {
      listener("SIGTERM"); process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) if (!previousInt.has(listener)) process.removeListener("SIGINT", listener);
  }
  expect(fixture.stopWorkers).toHaveBeenCalledOnce();
  expect(fixture.server.close).toHaveBeenCalledOnce();
});
