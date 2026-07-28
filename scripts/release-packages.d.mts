export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
  readonly manifest?: string;
  readonly output?: string;
}

export const RELEASE_PACKAGES: readonly {
  readonly directory: string;
  readonly name: string;
}[];
export function parseArguments(
  arguments_: readonly string[],
): ValidationOptions;
export function validateRepository(
  options?: ValidationOptions,
): Promise<unknown>;
export function verifyPreparedManifest(path: string): Promise<unknown>;
export function validateReleaseTag(options?: ValidationOptions): {
  headCommit: string;
  releaseTag: string;
};
export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";
export function checkRegistry(
  options?: ValidationOptions,
): Promise<"absent" | "publish" | "skip">;
export function prepareRelease(options?: ValidationOptions): Promise<{
  manifestPath: string;
  manifest: unknown;
}>;
export function publishPreparedRelease(
  options?: ValidationOptions,
): Promise<void>;
