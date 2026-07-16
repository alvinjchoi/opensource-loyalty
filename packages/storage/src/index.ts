export interface StateStore<T> {
  load(): T | null;
  save(state: T): void;
  clear(): void;
  close(): void;
}

export interface StateStoreStatus {
  driver: string;
  location: string;
  persistent: boolean;
}

export interface VersionedState<T> {
  state: T;
  revision: number;
}

export interface AsyncStateStore<T> {
  load(): Promise<VersionedState<T> | null>;
  save(state: T, expectedRevision?: number): Promise<number>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export class StateRevisionConflictError extends Error {
  public readonly expectedRevision: number;
  public readonly actualRevision: number;

  public constructor(expectedRevision: number, actualRevision: number) {
    super(`State revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.name = "StateRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
