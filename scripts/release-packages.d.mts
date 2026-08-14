export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
  readonly requireBootstrapTag?: boolean;
  readonly bootstrap?: boolean;
  readonly manifest?: string;
  readonly output?: string;
  readonly registry?: string;
}

export const RELEASE_PACKAGES: readonly {
  readonly directory: string;
  readonly name: string;
}[];
export const PACKAGE_FILES: readonly string[];
export function isNormalReleaseVersion(version: unknown): boolean;
export function decodeYamlScalar(raw: string): string;
export function resolvedVersionMatchesSpecifier(
  version: string,
  specifier: string,
): boolean;
export function requirePnpmLockDependencies(
  lockfile: string,
  importer: string,
  dependencies: Readonly<Record<string, string>>,
): void;
export function publicRegistryArguments(
  arguments_: readonly string[],
  registry?: string,
): string[];
export function parseArguments(
  arguments_: readonly string[],
): ValidationOptions;
export function validateRepository(
  options?: ValidationOptions,
): Promise<unknown>;
export function verifyPreparedManifest(path: string): Promise<unknown>;
export function verifyPreparedBootstrapManifest(path: string): Promise<unknown>;
export function verifyBootstrapPreparation(
  options?: ValidationOptions,
): Promise<unknown>;
export function validateBootstrapTag(options?: ValidationOptions): {
  headCommit: string;
  releaseTag: string;
};
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
export function prepareBootstrap(options?: ValidationOptions): Promise<{
  manifestPath: string;
  manifest: unknown;
}>;
export function checkBootstrapRegistry(
  options?: ValidationOptions,
): Promise<"publish" | "skip">;
export function publishPreparedRelease(
  options?: ValidationOptions,
): Promise<void>;
