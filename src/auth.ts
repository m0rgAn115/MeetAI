import { Request } from "express";
import { RequestContext } from "./contracts";
import { isDatabaseConfigured } from "./db";

const DEMO_WORKSPACE_ID = process.env.DEMO_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001";
const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "00000000-0000-0000-0000-000000000002";
const LOCAL_WORKSPACE_ID = process.env.LOCAL_WORKSPACE_ID ?? DEMO_WORKSPACE_ID;
const LOCAL_USER_ID = process.env.LOCAL_USER_ID ?? DEMO_USER_ID;

async function verifiedUserId(req: Request): Promise<string | null> {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  const { createRemoteJWKSet, jwtVerify } = await import("jose");
  if (process.env.SUPABASE_URL) {
    const jwks = createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks);
    return typeof payload.sub === "string" ? payload.sub : null;
  }
  if (process.env.SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET));
    return typeof payload.sub === "string" ? payload.sub : null;
  }
  throw new Error("AUTH_NOT_CONFIGURED");
}

export async function authenticateRequest(req: Request): Promise<RequestContext> {
  const workspaceId = String(req.header("x-workspace-id") ?? req.body?.workspaceId ?? "");
  const verified = await verifiedUserId(req);
  if (verified && workspaceId) {
    return {
      workspaceId,
      userId: verified,
      projectId: req.body?.projectId ? String(req.body.projectId) : null,
      participantIds: Array.isArray(req.body?.participantIds) ? req.body.participantIds.map(String) : [],
    };
  }
  if (!isDatabaseConfigured() || process.env.ALLOW_LOCAL_IDENTITY === "true" || process.env.ALLOW_DEMO_IDENTITY === "true") {
    const requestedWorkspace = workspaceId || LOCAL_WORKSPACE_ID;
    if (isDatabaseConfigured() && requestedWorkspace !== LOCAL_WORKSPACE_ID) {
      throw new Error("FORBIDDEN: local identity is restricted to LOCAL_WORKSPACE_ID");
    }
    return {
      workspaceId: requestedWorkspace,
      userId: LOCAL_USER_ID,
      projectId: req.body?.projectId ? String(req.body.projectId) : null,
      participantIds: Array.isArray(req.body?.participantIds) ? req.body.participantIds.map(String) : [],
    };
  }
  throw new Error("UNAUTHENTICATED");
}
