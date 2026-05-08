import { createMiddleware } from "hono/factory";
import type { Env, UserPayload } from "../types";
import { verifyAccessToken } from "../auth/jwt";
import { hashPAT } from "../auth/pat";

type AuthEnv = {
  Bindings: Env;
  Variables: { user: UserPayload };
};

export const authRequired = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (!token) {
    return c.json({ code: 16, message: "user not found", details: [] }, 401);
  }

  // Check if it's a PAT
  if (token.startsWith("memos_pat_")) {
    const hash = await hashPAT(token);
    const result = await c.env.DB.prepare(
      `SELECT us.user_id, u.username, u.role, u.row_status
       FROM user_setting us
       JOIN user u ON u.id = us.user_id
       WHERE us.key = 'personal_access_tokens' AND us.value LIKE ?`
    )
      .bind(`%${hash}%`)
      .first<{ user_id: number; username: string; role: string; row_status: string }>();

    if (!result) {
      return c.json({ code: 16, message: "invalid access token", details: [] }, 401);
    }

    c.set("user", {
      id: result.user_id,
      username: result.username,
      role: result.role,
      status: result.row_status,
    });
    return next();
  }

  try {
    const claims = await verifyAccessToken(token, c.env.JWT_SECRET);
    c.set("user", {
      id: Number(claims.sub),
      username: claims.name,
      role: claims.role,
      status: claims.status,
    });
    return next();
  } catch {
    return c.json({ code: 16, message: "token has expired", details: [] }, 401);
  }
});

export const authOptional = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  let token: string | undefined;

  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (token) {
    if (token.startsWith("memos_pat_")) {
      const hash = await hashPAT(token);
      const result = await c.env.DB.prepare(
        `SELECT us.user_id, u.username, u.role, u.row_status
         FROM user_setting us
         JOIN user u ON u.id = us.user_id
         WHERE us.key = 'personal_access_tokens' AND us.value LIKE ?`
      )
        .bind(`%${hash}%`)
        .first<{ user_id: number; username: string; role: string; row_status: string }>();

      if (result) {
        c.set("user", {
          id: result.user_id,
          username: result.username,
          role: result.role,
          status: result.row_status,
        });
      }
    } else {
      try {
        const claims = await verifyAccessToken(token, c.env.JWT_SECRET);
        c.set("user", {
          id: Number(claims.sub),
          username: claims.name,
          role: claims.role,
          status: claims.status,
        });
      } catch {
        // Token invalid, continue without user
      }
    }
  }

  return next();
});
