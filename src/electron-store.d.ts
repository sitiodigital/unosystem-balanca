declare module 'electron-store' {
  interface Options<T extends Record<string, unknown> = Record<string, unknown>> {
    name?: string;
    defaults?: T;
  }

  export default class Store<T extends Record<string, unknown> = Record<string, unknown>> {
    constructor(options?: Options<T>);
    get<K extends keyof T>(key: K): T[K];
    set<K extends keyof T>(key: K, value: T[K]): void;
    delete(key: keyof T): void;
    clear(): void;
  }
}
