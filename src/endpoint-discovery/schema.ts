import { z } from 'zod';

/** Schema for the local hook endpoint discovery file. */
export const HookEndpointFile = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[0-9a-f]{32}$/),
  url: z.string().url().optional(),
  startedAt: z.string().min(1),
  projectRoots: z.array(z.string().min(1)),
});

/** Validated hook endpoint discovery file. */
export type HookEndpointFileData = z.infer<typeof HookEndpointFile>;

/** Default discovery-file path relative to the user's home directory. */
export const DEFAULT_ENDPOINT_FILE_RELPATH =
  '.claude/libar-cockpit/endpoint.json';
