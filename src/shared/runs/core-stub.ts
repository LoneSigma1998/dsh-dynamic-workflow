/** Minimal stand-ins for the ZCode protocol-v4 core constants the run-state modules use. */
import { z } from "zod";

export const PROTOCOL_V4_LIMITS = {
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
} as const;

export const v4ColdResumeWorkspaceSchema = z.unknown().optional();
