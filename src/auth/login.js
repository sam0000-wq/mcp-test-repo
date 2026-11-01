// 高風險模組：認證與授權。權限判斷只能在這裡（後端），不准散佈到前端。
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分鐘
const ROLES = ["member", "admin", "finance"];

export function createSession(user, now = Date.now()) {
  if (!user?.id) throw new Error("缺少使用者 id");
  if (!ROLES.includes(user.role)) throw new Error(`未知角色：${user.role}`);
  return {
    userId: user.id,
    role: user.role,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
}

export function isSessionValid(session, now = Date.now()) {
  if (!session) return false;
  return session.expiresAt > now;
}

// 注意：這裡刻意不做「前端傳來 role 就相信」的事，一律以 session 內的 role 為準
export function isAuthorized(session, requiredRole, now = Date.now()) {
  if (!isSessionValid(session, now)) return false;
  if (!ROLES.includes(requiredRole)) throw new Error(`未知角色需求：${requiredRole}`);
  const rank = { member: 1, admin: 2, finance: 3 };
  return rank[session.role] >= rank[requiredRole];
}

export function describeForLog(session) {
  // log 裡不出現个資與 token，只留可追蹤的欄位
  return { userId: session?.userId, role: session?.role, expiresAt: session?.expiresAt };
}
