/**
 * Identifies the resource generation that owns an asynchronous pipeline
 * request.
 *
 * @internal
 */
export interface WebGPUPipelineRequestToken<TResources extends object> {
  readonly generation: number;
  readonly resources: TResources;
}

/**
 * Prevents asynchronous pipeline results from publishing after their resource
 * object has been superseded.
 *
 * @internal
 */
export class WebGPUPipelineRequestGuard<TResources extends object> {
  private _generation = 0;
  private _resources: TResources | undefined = undefined;

  /**
   * Supersedes every request token minted by this guard.
   */
  invalidate(): void {
    this._generation++;
    this._resources = undefined;
  }

  /**
   * Makes one resource object the only current publication source.
   */
  beginRequest(resources: TResources): WebGPUPipelineRequestToken<TResources> {
    this._resources = resources;
    return {
      generation: this._generation,
      resources,
    };
  }

  /**
   * Returns whether a token still owns both the generation and resource
   * identity allowed to publish.
   */
  isCurrent(token: WebGPUPipelineRequestToken<TResources>): boolean {
    return (
      token.generation === this._generation &&
      token.resources === this._resources
    );
  }

  /**
   * Publishes a result only while its request token remains current.
   */
  publishIfCurrent(
    token: WebGPUPipelineRequestToken<TResources>,
    publish: () => void,
  ): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    publish();
    return true;
  }
}
