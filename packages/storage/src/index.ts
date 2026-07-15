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
