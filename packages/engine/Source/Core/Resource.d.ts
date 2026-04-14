/**
 * Sidecar TypeScript declaration for Resource.js.
 *
 * MINIMAL — exposes only what WebGPU TS code currently touches. Extend as
 * new properties/methods are accessed from TS callers. The canonical
 * Resource API surface is in Resource.js itself.
 *
 * Pattern: co-located .d.ts overrides JS inference for default imports
 * (see CLAUDE.md). No tsconfig changes required.
 *
 * @private
 */

/**
 * Structural proxy interface (see Cesium's DefaultProxy). Only the single
 * method WebGPU code ever needs is declared — other callers use Resource
 * via JS where full inference happens from Resource.js.
 */
export interface ResourceProxy {
  getURL(resource: string): string;
}

/** Cesium's Request class (see Core/Request.js). Opaque here — WebGPU code
 *  only passes `Request` objects through; it never introspects them. */
export interface ResourceRequest {
  readonly requestFunction?: (url: string) => Promise<unknown>;
  readonly cancel?: () => void;
  readonly type?: number;
}

/** Options bag accepted by `new Resource(...)` and the static fetch* helpers. */
export interface ResourceOptions {
  /** The URL of the resource. */
  url: string;
  /** Query string parameters that will be combined with the URL. */
  queryParameters?: Record<string, string>;
  /** Template parameters that will be combined with the URL. */
  templateValues?: Record<string, string>;
  /** Additional HTTP headers sent with the request. */
  headers?: Record<string, string>;
  /** Proxy URL used when making cross-origin requests. */
  proxy?: ResourceProxy;
  /** Retry callback invoked when a request fails. */
  retryCallback?: (resource: Resource, error: Error) => Promise<boolean>;
  /** Maximum number of retry attempts. */
  retryAttempts?: number;
  /** Underlying request object. */
  request?: ResourceRequest;
  /** When true, the resource's URL is treated as server-trusted. */
  parseUrl?: boolean;
}

/** A wrapped URL plus associated retry / header / query-string state. */
export declare class Resource {
  constructor(options: string | ResourceOptions);

  /** The fully-built URL (accounts for template values, query params, etc.). */
  get url(): string;

  /**
   * Assembles the URL, optionally including query string and proxy
   * rewriting. `get url()` is equivalent to `getUrlComponent(true, true)`.
   */
  getUrlComponent(query?: boolean, proxy?: boolean): string;

  /** Clone this resource. */
  clone(result?: Resource): Resource;

  /** Append a trailing path segment and return a new Resource. */
  getDerivedResource(options: {
    url: string;
    queryParameters?: Record<string, string>;
    templateValues?: Record<string, string>;
    headers?: Record<string, string>;
    preserveQueryParameters?: boolean;
  }): Resource;

  /** Promise-returning fetchers used across the engine. */
  fetchArrayBuffer(): Promise<ArrayBuffer>;
  fetchBlob(): Promise<Blob>;
  fetchImage(options?: {
    preferImageBitmap?: boolean;
    preferBlob?: boolean;
    flipY?: boolean;
    skipColorSpaceConversion?: boolean;
  }): Promise<ImageBitmap | HTMLImageElement>;
  fetchText(): Promise<string>;
  fetchJson<T = unknown>(): Promise<T>;
  fetchXML(): Promise<XMLDocument>;

  /** Static convenience factories accepting the same options. */
  static createIfNeeded(resource: string | Resource): Resource;
  static fetchArrayBuffer(
    options: string | ResourceOptions,
  ): Promise<ArrayBuffer>;
  static fetchImage(
    options: string | ResourceOptions,
  ): Promise<ImageBitmap | HTMLImageElement>;
  static fetchJson<T = unknown>(options: string | ResourceOptions): Promise<T>;
}

export default Resource;
