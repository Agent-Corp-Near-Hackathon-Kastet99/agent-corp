import { AsyncLocalStorage } from "node:async_hooks";

/** Tracks accepted work and allows its nested operations to finish while draining. */
export class GrowthLifecycle {
  private readonly context = new AsyncLocalStorage<boolean>();
  private active = 0;
  private stopping = false;
  private drained?: () => void;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping && !this.context.getStore()) return Promise.reject(new Error("growth is shutting down"));
    this.active++;
    let result: Promise<T>;
    try { result = this.context.run(true, work); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).finally(() => {
      this.active--;
      if (!this.active) this.drained?.();
    });
  }

  drain(): Promise<void> {
    this.stopping = true;
    return this.active ? new Promise(resolve => { this.drained = resolve; }) : Promise.resolve();
  }
}
