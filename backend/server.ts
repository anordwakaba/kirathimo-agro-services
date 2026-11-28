import dotenv from "dotenv";
dotenv.config({ path: "../.env.local" });
import express, { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";
import { createLocalSql } from "./db-local.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const sql = process.env.LOCAL_DB_HOST
  ? createLocalSql()
  : neon(process.env.DATABASE_URL || "");
const SECRET = process.env.JWT_SECRET || "";

let ready: Promise<void> | null = null;

const ALL_PERMISSIONS = [
  "dashboard",
  "sales",
  "purchases",
  "inventory",
  "reports",
  "banking",
  "customers",
  "finance",
  "team",
  "settings",
] as const;

type Permission = typeof ALL_PERMISSIONS[number];

type User = {
  id: string;
  name: string;
  email: string;
  role: "owner" | "worker";
  businessId: string;
  isActive: boolean;
  permissions: Permission[];
};

type R = Request & { user?: User };

function n(v: unknown) {
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
}

function permissionsForRole(
  role: "owner" | "worker",
  permissions: unknown
): Permission[] {
  if (role === "owner") return [...ALL_PERMISSIONS];

  if (!Array.isArray(permissions)) return [];

  return permissions.filter((p): p is Permission =>
    ALL_PERMISSIONS.includes(p as Permission)
  );
}

function hasPermission(user: User, permission: Permission) {
  return user.role === "owner" || user.permissions.includes(permission);
}

function requirePermission(permission: Permission) {
  return (req: R, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!hasPermission(req.user, permission)) {
      return res.status(403).json({
        error: `You do not have permission to access ${permission}.`,
      });
    }

    next();
  };
}

async function audit(
  businessId: string,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {}
) {
  try {
    await sql`
      INSERT INTO audit_logs
      (business_id, actor_id, action, entity_type, entity_id, details)
      VALUES
      (${businessId}, ${actorId}, ${action}, ${entityType}, ${entityId}, ${JSON.stringify(details)}::jsonb)
    `;
  } catch (error) {
    console.error("Audit log failed:", error);
  }
}

async function schema() {
  if (ready) return ready;

  ready = (async () => {
    /*
     * Existing tables.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS users(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','worker')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS invitations(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','worker')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS items(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Other',
        unit TEXT NOT NULL,
        stock_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
        cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      ALTER TABLE items
      ADD COLUMN IF NOT EXISTS pack_size NUMERIC(14,3) NOT NULL DEFAULT 1
    `;

    await sql`
      ALTER TABLE items
      ADD COLUMN IF NOT EXISTS pack_label TEXT NOT NULL DEFAULT 'pack'
    `;

    await sql`
      ALTER TABLE items
      ADD COLUMN IF NOT EXISTS pack_selling_price NUMERIC(14,2) NOT NULL DEFAULT 0
    `;

    await sql`
      ALTER TABLE items
      ALTER COLUMN stock_qty TYPE NUMERIC(14,3)
      USING stock_qty::NUMERIC(14,3)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS transactions(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        date DATE NOT NULL,
        type TEXT NOT NULL CHECK(
          type IN ('sale','purchase','expense','cash_in','cash_out')
        ),
        item_id UUID REFERENCES items(id) ON DELETE SET NULL,
        item_name TEXT,
        quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
        unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
        amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
        cogs NUMERIC(14,2) NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL DEFAULT 'Cash',
        notes TEXT,
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      ALTER TABLE transactions
      ALTER COLUMN quantity TYPE NUMERIC(14,3)
      USING quantity::NUMERIC(14,3)
    `;

    /*
     * Multi-business foundation.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS businesses(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        business_type TEXT NOT NULL DEFAULT 'general_retail',
        currency TEXT NOT NULL DEFAULT 'KES',
        owner_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id)
    `;

    await sql`
      ALTER TABLE items
      ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id)
    `;

    await sql`
      ALTER TABLE transactions
      ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id)
    `;

    await sql`
      ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id)
    `;

    await sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
    `;

    await sql`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb
    `;

    await sql`
      ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb
    `;

    await sql`
      ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS token_hash TEXT
    `;

    await sql`
      ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
    `;

    await sql`
      ALTER TABLE invitations
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS password_reset_tokens(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS
      password_reset_tokens_user_idx
      ON password_reset_tokens(user_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS
      password_reset_tokens_expiry_idx
      ON password_reset_tokens(expires_at)
    `;


    /*
     * Audit history.
     */
    await sql`
      CREATE TABLE IF NOT EXISTS audit_logs(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    /*
     * Existing indexes.
     */
    await sql`
      CREATE INDEX IF NOT EXISTS transactions_date_idx
      ON transactions(date)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS users_business_idx
      ON users(business_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS items_business_idx
      ON items(business_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS transactions_business_date_idx
      ON transactions(business_id, date)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS invitations_business_idx
      ON invitations(business_id)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS audit_logs_business_date_idx
      ON audit_logs(business_id, created_at)
    `;

    /*
     * Ensure the existing Kirathimo owner has a business.
     */
    const owner = await sql`
      SELECT id, business_id
      FROM users
      WHERE email = 'wakabaanord9@gmail.com'
      LIMIT 1
    `;

    if (owner.length) {
      let businessId = owner[0].business_id as string | null;

      if (!businessId) {
        const existing = await sql`
          SELECT id
          FROM businesses
          WHERE name = 'Kirathimo Agro Services'
          ORDER BY created_at
          LIMIT 1
        `;

        if (existing.length) {
          businessId = existing[0].id as string;
        } else {
          const created = await sql`
            INSERT INTO businesses
            (name, business_type, currency, owner_user_id)
            VALUES
            ('Kirathimo Agro Services', 'agro_retail', 'KES', ${owner[0].id})
            RETURNING id
          `;

          businessId = created[0].id as string;
        }

        await sql`
          UPDATE users
          SET business_id = ${businessId},
              role = 'owner',
              is_active = TRUE,
              permissions = ${JSON.stringify(ALL_PERMISSIONS)}::jsonb
          WHERE id = ${owner[0].id}
        `;
      }

      await sql`
        UPDATE businesses
        SET owner_user_id = ${owner[0].id}
        WHERE id = ${businessId}
      `;

      await sql`
        UPDATE users
        SET permissions = ${JSON.stringify(ALL_PERMISSIONS)}::jsonb
        WHERE role = 'owner'
          AND business_id = ${businessId}
      `;

      await sql`
        UPDATE items
        SET business_id = ${businessId}
        WHERE business_id IS NULL
      `;

      await sql`
        UPDATE transactions
        SET business_id = ${businessId}
        WHERE business_id IS NULL
      `;

      await sql`
        UPDATE invitations
        SET business_id = ${businessId}
        WHERE business_id IS NULL
      `;
    }
  })().catch((error) => {
    ready = null;
    throw error;
  });

  return ready;
}

function token(req: Request) {
  const h = req.headers.authorization;

  if (h?.startsWith("Bearer ")) {
    return h.slice(7);
  }

  const c = req.headers.cookie || "";

  return c.match(/(?:^|; )ka_token=([^;]+)/)?.[1];
}

async function auth(
  req: R,
  res: Response,
  next: NextFunction
) {
  try {
    if (!SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    await schema();

    const t = token(req);

    if (!t) {
      throw new Error("Missing token");
    }

    const p: any = jwt.verify(t, SECRET);

    const rows = await sql`
      SELECT
        id,
        name,
        email,
        role,
        business_id,
        is_active,
        permissions
      FROM users
      WHERE id = ${p.sub}
      LIMIT 1
    `;

    if (!rows.length || !rows[0].is_active || !rows[0].business_id) {
      throw new Error("Account inactive");
    }

    const u = rows[0];

    req.user = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      businessId: u.business_id,
      isActive: u.is_active,
      permissions: permissionsForRole(u.role, u.permissions),
    };

    next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

function owner(
  req: R,
  res: Response,
  next: NextFunction
) {
  if (req.user?.role !== "owner") {
    return res.status(403).json({
      error: "Only the business owner can do this.",
    });
  }

  next();
}

const cookie = (t: string) =>
  `ka_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;

const clear =
  "ka_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

function invitationHash(token: string) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function appUrl() {
  return (
    process.env.APP_URL ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:5173")
  ).replace(/\/$/, "");
}

async function sendEmail(
  to: string,
  subject: string,
  html: string
) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error(
      "Email service is not configured. Set RESEND_API_KEY and EMAIL_FROM."
    );
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Email provider rejected the message: ${body.slice(0, 500)}`
    );
  }
}

function emailButton(
  url: string,
  label: string
) {
  return `
    <a href="${url}"
      style="
        display:inline-block;
        padding:13px 22px;
        background:#0a4b2c;
        color:#fff;
        text-decoration:none;
        border-radius:10px;
        font-weight:700
      ">
      ${label}
    </a>
  `;
}

async function sendInvitationEmail(params: {
  email: string;
  name: string;
  role: string;
  invitationUrl: string;
  expiresAt: Date;
}) {
  const {
    email,
    name,
    role,
    invitationUrl,
    expiresAt,
  } = params;

  await sendEmail(
    email,
    "You're invited to Kirathimo Agro Services",
    `
      <div style="
        font-family:Arial,sans-serif;
        max-width:620px;
        margin:0 auto;
        color:#17231c
      ">

        <div style="
          background:#06351f;
          padding:24px;
          border-radius:14px 14px 0 0;
          color:#fff
        ">
          <div style="
            font-size:22px;
            font-weight:800
          ">
            KIRATHIMO
          </div>

          <div style="
            font-size:12px;
            letter-spacing:2px;
            color:#c7ef72
          ">
            AGRO SERVICES
          </div>
        </div>

        <div style="
          padding:30px;
          border:1px solid #e5e9e6;
          border-top:0;
          border-radius:0 0 14px 14px
        ">

          <h2>You're invited, ${name}</h2>

          <p>
            You have been invited to join
            <strong>Kirathimo Agro Services</strong>
            as a <strong>${role}</strong>.
          </p>

          <p>
            Click below to accept the invitation and create
            your password.
          </p>

          <p>
            Your account will use this invited email address:
            <strong>${email}</strong>.
          </p>

          <p style="margin:26px 0">
            ${emailButton(
              invitationUrl,
              "Accept invitation & create password"
            )}
          </p>

          <p style="
            font-size:13px;
            color:#64736a
          ">
            This invitation expires on
            ${expiresAt.toLocaleString("en-KE")}.
          </p>

          <p style="
            font-size:13px;
            color:#64736a
          ">
            If the button does not work, copy this address
            into your browser:<br/>
            ${invitationUrl}
          </p>

          <p style="
            font-size:13px;
            color:#64736a
          ">
            If you were not expecting this invitation,
            you can ignore this email.
          </p>

        </div>
      </div>
    `
  );
}

async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string
) {
  await sendEmail(
    email,
    "Reset your Kirathimo Agro Services password",
    `
      <div style="
        font-family:Arial,sans-serif;
        max-width:620px;
        margin:0 auto;
        color:#17231c
      ">

        <div style="
          background:#06351f;
          padding:24px;
          border-radius:14px 14px 0 0;
          color:#fff
        ">
          <div style="
            font-size:22px;
            font-weight:800
          ">
            KIRATHIMO
          </div>

          <div style="
            font-size:12px;
            letter-spacing:2px;
            color:#c7ef72
          ">
            AGRO SERVICES
          </div>
        </div>

        <div style="
          padding:30px;
          border:1px solid #e5e9e6;
          border-top:0;
          border-radius:0 0 14px 14px
        ">

          <h2>Password reset request</h2>

          <p>
            Hello ${name},
          </p>

          <p>
            We received a request to change the password
            for your Kirathimo account.
          </p>

          <p style="margin:26px 0">
            ${emailButton(
              resetUrl,
              "Create a new password"
            )}
          </p>

          <p style="
            font-size:13px;
            color:#64736a
          ">
            This link expires in 60 minutes and can only
            be used once.
          </p>

          <p style="
            font-size:13px;
            color:#64736a
          ">
            If you did not request this, you can safely
            ignore this email.
          </p>

        </div>
      </div>
    `
  );
}

function resetTokenHash(rawToken: string) {
  return crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
}


function invitationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function makeJwt(user: User) {
  return jwt.sign(
    {
      sub: user.id,
      businessId: user.businessId,
    },
    SECRET,
    { expiresIn: "7d" }
  );
}

app.get("/api/health", async (_req, res) => {
  try {
    await schema();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/*
 * Registration:
 *
 * - If there are no users, create the first business owner.
 * - Otherwise registration requires a secure invitation token.
 */
app.post("/api/auth/register", async (req, res) => {
  try {
    await schema();

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");
    const inviteToken = String(req.body.inviteToken || "").trim();

    if (
      name.length < 2 ||
      !email.includes("@") ||
      password.length < 8
    ) {
      return res.status(400).json({
        error:
          "Name, valid email and password of at least 8 characters are required.",
      });
    }

    const count = await sql`
      SELECT COUNT(*)::int AS c
      FROM users
    `;

    let businessId = "";
    let role: "owner" | "worker" = "owner";
    let permissions: Permission[] = [...ALL_PERMISSIONS];
    let invitationId: string | null = null;

    if (Number(count[0].c) === 0) {
      const business = await sql`
        INSERT INTO businesses
        (name, business_type, currency)
        VALUES
        ('Kirathimo Agro Services', 'agro_retail', 'KES')
        RETURNING id
      `;

      businessId = business[0].id as string;
    } else {
      if (!inviteToken) {
        return res.status(403).json({
          error:
            "Registration requires a valid invitation from a business owner.",
        });
      }

      const hash = invitationHash(inviteToken);

      const inv = await sql`
        SELECT
          id,
          business_id,
          name,
          role,
          permissions,
          expires_at,
          used_at
        FROM invitations
        WHERE email = ${email}
          AND token_hash = ${hash}
        LIMIT 1
      `;

      if (!inv.length) {
        return res.status(403).json({
          error: "Invalid invitation.",
        });
      }

      if (inv[0].used_at) {
        return res.status(403).json({
          error: "This invitation has already been used.",
        });
      }

      if (
        inv[0].expires_at &&
        new Date(inv[0].expires_at).getTime() < Date.now()
      ) {
        return res.status(403).json({
          error: "This invitation has expired.",
        });
      }

      businessId = inv[0].business_id;

      const invitedRole =
        inv[0].role === "owner"
          ? "owner"
          : "worker";

      role = invitedRole;

      permissions =
        invitedRole === "owner"
          ? [...ALL_PERMISSIONS]
          : permissionsForRole(
              "worker",
              inv[0].permissions
            );

      invitationId = inv[0].id;
    }

    const existing = await sql`
      SELECT id
      FROM users
      WHERE email = ${email}
      LIMIT 1
    `;

    if (existing.length) {
      return res.status(409).json({
        error: "That email is already registered.",
      });
    }

    const hash = await bcrypt.hash(password, 12);

    const rows = await sql`
      INSERT INTO users
      (
        name,
        email,
        password_hash,
        role,
        business_id,
        is_active,
        permissions
      )
      VALUES
      (
        ${name},
        ${email},
        ${hash},
        ${role},
        ${businessId},
        TRUE,
        ${JSON.stringify(permissions)}::jsonb
      )
      RETURNING id, name, email, role, business_id, is_active, permissions
    `;

    const u = rows[0];

    if (role === "owner") {
      await sql`
        UPDATE businesses
        SET owner_user_id = ${u.id}
        WHERE id = ${businessId}
      `;
    }

    if (invitationId) {
      await sql`
        UPDATE invitations
        SET used_at = NOW()
        WHERE id = ${invitationId}
      `;
    }

    const user: User = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      businessId: u.business_id,
      isActive: u.is_active,
      permissions: permissionsForRole(
        u.role,
        u.permissions
      ),
    };

    await audit(
      businessId,
      user.id,
      "account_created",
      "user",
      user.id,
      { role: user.role }
    );

    res.setHeader("Set-Cookie", cookie(makeJwt(user)));

    res.status(201).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
      },
    });
  } catch (error: any) {
    console.error(error);

    if (String(error.message).includes("duplicate")) {
      return res.status(409).json({
        error: "That email is already registered.",
      });
    }

    res.status(500).json({
      error: "Could not create account.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    await schema();

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const rows = await sql`
      SELECT
        id,
        name,
        email,
        password_hash,
        role,
        business_id,
        is_active,
        permissions
      FROM users
      WHERE email = ${email}
      LIMIT 1
    `;

    if (
      !rows.length ||
      !(await bcrypt.compare(
        password,
        rows[0].password_hash
      ))
    ) {
      return res.status(401).json({
        error: "Incorrect email or password.",
      });
    }

    if (!rows[0].is_active) {
      return res.status(403).json({
        error: "Your account has been disabled. Contact the business owner.",
      });
    }

    const u = rows[0];

    const user: User = {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      businessId: u.business_id,
      isActive: u.is_active,
      permissions: permissionsForRole(
        u.role,
        u.permissions
      ),
    };

    await audit(
      user.businessId,
      user.id,
      "login",
      "user",
      user.id
    );

    res.setHeader("Set-Cookie", cookie(makeJwt(user)));

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Login failed.",
    });
  }
});


app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      await schema();

      const email = String(
        req.body.email || ""
      ).trim().toLowerCase();

      if (!email || !email.includes("@")) {
        return res.status(400).json({
          error: "Enter a valid email address.",
        });
      }

      const users = await sql`
        SELECT id, name, email, is_active
        FROM users
        WHERE email = ${email}
        LIMIT 1
      `;

      if (
        users.length &&
        users[0].is_active
      ) {
        const rawToken =
          crypto.randomBytes(32).toString("hex");

        const hash =
          resetTokenHash(rawToken);

        const expires =
          new Date(
            Date.now() +
            60 * 60 * 1000
          );

        await sql`
          UPDATE password_reset_tokens
          SET used_at = NOW()
          WHERE user_id = ${users[0].id}
            AND used_at IS NULL
        `;

        await sql`
          INSERT INTO password_reset_tokens
          (
            user_id,
            token_hash,
            expires_at
          )
          VALUES
          (
            ${users[0].id},
            ${hash},
            ${expires}
          )
        `;

        const resetUrl =
          `${appUrl()}/?resetToken=${encodeURIComponent(rawToken)}`;

        await sendPasswordResetEmail(
          users[0].email,
          users[0].name,
          resetUrl
        );
      }

      res.json({
        ok: true,
        message:
          "If that email is registered, a password reset link has been sent.",
      });

    } catch (error) {
      console.error(
        "Forgot password:",
        error
      );

      res.status(500).json({
        error:
          "Could not send the password reset email.",
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      await schema();

      const rawToken =
        String(req.body.token || "").trim();

      const password =
        String(req.body.password || "");

      if (
        !rawToken ||
        password.length < 8
      ) {
        return res.status(400).json({
          error:
            "A valid reset token and password of at least 8 characters are required.",
        });
      }

      const hash =
        resetTokenHash(rawToken);

      const rows = await sql`
        SELECT
          pr.id,
          pr.user_id,
          pr.expires_at,
          u.name,
          u.email,
          u.role,
          u.business_id,
          u.is_active,
          u.permissions
        FROM password_reset_tokens pr
        JOIN users u
          ON u.id = pr.user_id
        WHERE pr.token_hash = ${hash}
          AND pr.used_at IS NULL
        LIMIT 1
      `;

      if (
        !rows.length ||
        new Date(
          rows[0].expires_at
        ).getTime() < Date.now()
      ) {
        return res.status(400).json({
          error:
            "This password reset link is invalid or has expired.",
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      await sql`
        UPDATE users
        SET password_hash =
          ${passwordHash}
        WHERE id =
          ${rows[0].user_id}
      `;

      await sql`
        UPDATE password_reset_tokens
        SET used_at = NOW()
        WHERE id =
          ${rows[0].id}
      `;

      const user: User = {
        id: rows[0].user_id,
        name: rows[0].name,
        email: rows[0].email,
        role: rows[0].role,
        businessId:
          rows[0].business_id,
        isActive:
          rows[0].is_active,
        permissions:
          permissionsForRole(
            rows[0].role,
            rows[0].permissions
          ),
      };

      await audit(
        user.businessId,
        user.id,
        "password_reset",
        "user",
        user.id
      );

      res.setHeader(
        "Set-Cookie",
        cookie(makeJwt(user))
      );

      res.json({
        ok: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          permissions:
            user.permissions,
        },
      });

    } catch (error) {
      console.error(
        "Reset password:",
        error
      );

      res.status(500).json({
        error:
          "Could not reset password.",
      });
    }
  }
);

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", clear);
  res.json({ ok: true });
});

app.get("/api/auth/me", auth, (req: R, res) => {
  res.json({
    user: {
      id: req.user!.id,
      name: req.user!.name,
      email: req.user!.email,
      role: req.user!.role,
      permissions: req.user!.permissions,
    },
  });
});

/*
 * Inventory
 */
app.get(
  "/api/items",
  auth,
  requirePermission("inventory"),
  async (req: R, res) => {
    try {
      await schema();

      const r = await sql`
        SELECT
          id,
          name,
          category,
          unit,
          stock_qty::float8 AS "stockQty",
          cost_price::float8 AS "costPrice",
          selling_price::float8 AS "sellingPrice",
          pack_size::float8 AS "packSize",
          pack_label AS "packLabel",
          pack_selling_price::float8 AS "packSellingPrice"
        FROM items
        WHERE business_id = ${req.user!.businessId}
        ORDER BY name
      `;

      res.json({ items: r });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Could not load inventory.",
      });
    }
  }
);

app.post(
  "/api/items",
  auth,
  owner,
  requirePermission("inventory"),
  async (req: R, res) => {
    try {
      await schema();

      const name = String(req.body.name || "").trim();
      const unit = String(req.body.unit || "").trim();
      const category = String(
        req.body.category || "Other"
      ).trim();

      const stock = n(req.body.stockQty);
      const cost = n(req.body.costPrice);
      const sell = n(req.body.sellingPrice);
      const packSize = n(req.body.packSize ?? 1);
      const packLabel = String(
        req.body.packLabel || "pack"
      ).trim();
      const packPrice = n(
        req.body.packSellingPrice ?? 0
      );

      if (
        !name ||
        !unit ||
        !packLabel ||
        [stock, cost, sell, packSize, packPrice].some(
          (x) => !Number.isFinite(x) || x < 0
        ) ||
        packSize <= 0
      ) {
        return res.status(400).json({
          error:
            "Enter valid stock, package size and non-negative prices.",
        });
      }

      const r = await sql`
        INSERT INTO items
        (
          business_id,
          name,
          category,
          unit,
          stock_qty,
          cost_price,
          selling_price,
          pack_size,
          pack_label,
          pack_selling_price
        )
        VALUES
        (
          ${req.user!.businessId},
          ${name},
          ${category},
          ${unit},
          ${stock},
          ${cost},
          ${sell},
          ${packSize},
          ${packLabel},
          ${packPrice}
        )
        RETURNING id
      `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        "item_created",
        "item",
        r[0].id,
        { name }
      );

      res.status(201).json({ id: r[0].id });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Could not add item.",
      });
    }
  }
);

app.put(
  "/api/items/:id",
  auth,
  owner,
  requirePermission("inventory"),
  async (req: R, res) => {
    try {
      await schema();

      const name = String(req.body.name || "").trim();
      const unit = String(req.body.unit || "").trim();
      const category = String(
        req.body.category || "Other"
      ).trim();

      const stock = n(req.body.stockQty);
      const cost = n(req.body.costPrice);
      const sell = n(req.body.sellingPrice);
      const packSize = n(req.body.packSize ?? 1);
      const packLabel = String(
        req.body.packLabel || "pack"
      ).trim();
      const packPrice = n(
        req.body.packSellingPrice ?? 0
      );

      if (
        !name ||
        !unit ||
        !packLabel ||
        [stock, cost, sell, packSize, packPrice].some(
          (x) => !Number.isFinite(x) || x < 0
        ) ||
        packSize <= 0
      ) {
        return res.status(400).json({
          error:
            "Enter valid stock, package size and non-negative prices.",
        });
      }

      const r = await sql`
        UPDATE items
        SET
          name = ${name},
          category = ${category},
          unit = ${unit},
          stock_qty = ${stock},
          cost_price = ${cost},
          selling_price = ${sell},
          pack_size = ${packSize},
          pack_label = ${packLabel},
          pack_selling_price = ${packPrice},
          updated_at = NOW()
        WHERE id = ${req.params.id}
          AND business_id = ${req.user!.businessId}
        RETURNING id
      `;

      if (!r.length) {
        return res.status(404).json({
          error: "Item not found.",
        });
      }

      await audit(
        req.user!.businessId,
        req.user!.id,
        "item_updated",
        "item",
        String(req.params.id),
        { name }
      );

      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Could not update item.",
      });
    }
  }
);

/*
 * Shop transactions
 */
app.get(
  "/api/transactions",
  auth,
  requirePermission("reports"),
  async (req: R, res) => {
    try {
      await schema();

      const d = String(
        req.query.date ||
          new Date().toISOString().slice(0, 10)
      );

      const r = await sql`
        SELECT
          id,
          date::text,
          type,
          item_name AS "itemName",
          quantity::float8,
          amount::float8,
          cogs::float8,
          payment_method AS "paymentMethod",
          notes
        FROM transactions
        WHERE business_id = ${req.user!.businessId}
          AND date = ${d}
        ORDER BY created_at DESC
        LIMIT 200
      `;

      res.json({ items: r });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Could not load transactions.",
      });
    }
  }
);

app.post(
  "/api/transactions",
  auth,
  async (req: R, res) => {
    try {
      await schema();

      const type = String(req.body.type);
      const q = n(req.body.quantity);
      const p = n(req.body.unitPrice);
      const date = String(
        req.body.date ||
          new Date().toISOString().slice(0, 10)
      );
      const pay = String(
        req.body.paymentMethod || "Cash"
      );
      const notes = String(
        req.body.notes || ""
      );

      if (
        ![
          "sale",
          "purchase",
          "expense",
          "cash_in",
          "cash_out",
        ].includes(type)
      ) {
        return res.status(400).json({
          error: "Invalid transaction type.",
        });
      }

      const requiredPermission =
        type === "sale"
          ? "sales"
          : type === "purchase"
            ? "purchases"
            : "finance";

      if (!hasPermission(req.user!, requiredPermission)) {
        return res.status(403).json({
          error:
            "You do not have permission to create this transaction.",
        });
      }

      if (type === "sale" || type === "purchase") {
        if (
          !req.body.itemId ||
          !Number.isFinite(q) ||
          q <= 0 ||
          !Number.isFinite(p) ||
          p <= 0
        ) {
          return res.status(400).json({
            error:
              "Item, quantity and price are required.",
          });
        }

        const it = await sql`
          SELECT
            id,
            name,
            stock_qty::float8 AS stock,
            cost_price::float8 AS cost
          FROM items
          WHERE id = ${req.body.itemId}
            AND business_id = ${req.user!.businessId}
          LIMIT 1
        `;

        if (!it.length) {
          return res.status(404).json({
            error: "Item not found.",
          });
        }

        let cogs = 0;

        if (type === "sale") {
          if (Number(it[0].stock) < q) {
            return res.status(400).json({
              error: `Not enough stock. Available: ${it[0].stock}.`,
            });
          }

          cogs = q * Number(it[0].cost);

          const u = await sql`
            UPDATE items
            SET
              stock_qty = stock_qty - ${q},
              updated_at = NOW()
            WHERE id = ${req.body.itemId}
              AND business_id = ${req.user!.businessId}
              AND stock_qty >= ${q}
            RETURNING id
          `;

          if (!u.length) {
            return res.status(409).json({
              error:
                "Stock changed on another device. Refresh and try again.",
            });
          }
        } else {
          await sql`
            UPDATE items
            SET
              stock_qty = stock_qty + ${q},
              updated_at = NOW()
            WHERE id = ${req.body.itemId}
              AND business_id = ${req.user!.businessId}
          `;
        }

        const amount = q * p;

        const r = await sql`
          INSERT INTO transactions
          (
            business_id,
            date,
            type,
            item_id,
            item_name,
            quantity,
            unit_price,
            amount,
            cogs,
            payment_method,
            notes,
            created_by
          )
          VALUES
          (
            ${req.user!.businessId},
            ${date},
            ${type},
            ${req.body.itemId},
            ${it[0].name},
            ${q},
            ${p},
            ${amount},
            ${cogs},
            ${pay},
            ${notes},
            ${req.user!.id}
          )
          RETURNING id
        `;

        await audit(
          req.user!.businessId,
          req.user!.id,
          type === "sale"
            ? "sale_created"
            : "purchase_created",
          "transaction",
          r[0].id,
          {
            amount,
            itemName: it[0].name,
            quantity: q,
          }
        );

        return res.status(201).json({
          id: r[0].id,
        });
      }

      if (
        !Number.isFinite(p) ||
        p <= 0
      ) {
        return res.status(400).json({
          error:
            "Amount must be greater than zero.",
        });
      }

      const r = await sql`
        INSERT INTO transactions
        (
          business_id,
          date,
          type,
          quantity,
          unit_price,
          amount,
          payment_method,
          notes,
          created_by
        )
        VALUES
        (
          ${req.user!.businessId},
          ${date},
          ${type},
          1,
          ${p},
          ${p},
          ${pay},
          ${notes},
          ${req.user!.id}
        )
        RETURNING id
      `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        `${type}_created`,
        "transaction",
        r[0].id,
        { amount: p }
      );

      res.status(201).json({
        id: r[0].id,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not save transaction.",
      });
    }
  }
);

app.get(
  "/api/summary",
  auth,
  requirePermission("dashboard"),
  async (req: R, res) => {
    try {
      await schema();

      const d = String(
        req.query.date ||
          new Date().toISOString().slice(0, 10)
      );

      const r = await sql`
        SELECT
          type,
          amount::float8,
          cogs::float8,
          payment_method AS "paymentMethod"
        FROM transactions
        WHERE business_id = ${req.user!.businessId}
          AND date = ${d}
      `;

      let sales = 0;
      let cogs = 0;
      let expenses = 0;
      let cashMovement = 0;

      const byPayment: Record<string, number> = {};

      for (const x of r) {
        const a = Number(x.amount);

        if (x.type === "sale") {
          sales += a;
          cogs += Number(x.cogs);
          cashMovement += a;
        } else if (x.type === "purchase") {
          cashMovement -= a;
        } else if (x.type === "expense") {
          expenses += a;
          cashMovement -= a;
        } else if (x.type === "cash_in") {
          cashMovement += a;
        } else if (x.type === "cash_out") {
          cashMovement -= a;
        }

        const sign = [
          "purchase",
          "expense",
          "cash_out",
        ].includes(x.type)
          ? -1
          : 1;

        byPayment[x.paymentMethod] =
          (byPayment[x.paymentMethod] || 0) +
          sign * a;
      }

      res.json({
        sales,
        cogs,
        expenses,
        netProfit:
          sales - cogs - expenses,
        cashMovement,
        byPayment,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not calculate report.",
      });
    }
  }
);

/*
 * Owner creates employee invitation.
 * Owners can no longer invite another owner.
 */
app.post(
  "/api/members",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      const email = String(
        req.body.email || ""
      ).trim().toLowerCase();

      const name = String(
        req.body.name || ""
      ).trim();

      if (
        !name ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          error:
            "Valid name and email are required.",
        });
      }

      const existing = await sql`
        SELECT id
        FROM users
        WHERE email = ${email}
        LIMIT 1
      `;

      if (existing.length) {
        return res.status(409).json({
          error:
            "That email is already registered.",
        });
      }

      const requestedRole =
        String(req.body.role || "worker")
          .trim()
          .toLowerCase();

      const role: "owner" | "worker" =
        requestedRole === "owner"
          ? "owner"
          : "worker";

      const permissions =
        role === "owner"
          ? [...ALL_PERMISSIONS]
          : Array.isArray(req.body.permissions)
            ? req.body.permissions.filter(
                (p: unknown): p is Permission =>
                  ALL_PERMISSIONS.includes(
                    p as Permission
                  ) &&
                  p !== "team" &&
                  p !== "settings"
              )
            : ["dashboard", "sales", "inventory"];

      const rawToken =
        invitationToken();

      const hash =
        invitationHash(rawToken);

      const expires =
        new Date(
          Date.now() +
            48 * 60 * 60 * 1000
        );

      const invitation =
        await sql`
          INSERT INTO invitations
          (
            email,
            name,
            role,
            business_id,
            permissions,
            token_hash,
            expires_at,
            used_at
          )
          VALUES
          (
            ${email},
            ${name},
            ${role},
            ${req.user!.businessId},
            ${JSON.stringify(permissions)}::jsonb,
            ${hash},
            ${expires},
            NULL
          )
          ON CONFLICT(email)
          DO UPDATE SET
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            business_id = EXCLUDED.business_id,
            permissions = EXCLUDED.permissions,
            token_hash = EXCLUDED.token_hash,
            expires_at = EXCLUDED.expires_at,
            used_at = NULL
          RETURNING id
        `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        "invitation_created",
        "invitation",
        invitation[0].id,
        {
          email,
          permissions,
        }
      );

      const invitationUrl =
        `${appUrl()}/?inviteToken=${encodeURIComponent(rawToken)}`;

      await sendInvitationEmail({
        email,
        name,
        role: "worker",
        invitationUrl,
        expiresAt: expires,
      });

      res.status(201).json({
        ok: true,
        message:
          "Invitation created and email sent.",
        expiresAt:
          expires.toISOString(),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not create invitation.",
      });
    }
  }
);

/*
 * Owner can disable/enable an employee.
 */
app.patch(
  "/api/members/:id/status",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      if (
        req.params.id ===
        req.user!.id
      ) {
        return res.status(400).json({
          error:
            "You cannot disable your own owner account.",
        });
      }

      const active =
        Boolean(req.body.isActive);

      const r = await sql`
        UPDATE users
        SET is_active = ${active}
        WHERE id = ${req.params.id}
          AND business_id = ${req.user!.businessId}
        RETURNING id, name, email, is_active
      `;

      if (!r.length) {
        return res.status(404).json({
          error:
            "Team member not found.",
        });
      }

      await audit(
        req.user!.businessId,
        req.user!.id,
        active
          ? "employee_enabled"
          : "employee_disabled",
        "user",
        String(req.params.id)
      );

      res.json({
        ok: true,
        user: r[0],
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not update employee status.",
      });
    }
  }
);

/*
 * Owner updates employee permissions.
 */
/*
 * Owner removes a team member.
 *
 * We deactivate instead of deleting the database record so
 * sales, banking, audit and other historical records remain
 * intact.
 */
app.delete(
  "/api/members/:id",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      if (req.params.id === req.user!.id) {
        return res.status(400).json({
          error:
            "You cannot remove your own owner account.",
        });
      }

      const r = await sql`
        UPDATE users
        SET is_active = FALSE
        WHERE id = ${req.params.id}
          AND business_id = ${req.user!.businessId}
        RETURNING id, name, email, role, is_active
      `;

      if (!r.length) {
        return res.status(404).json({
          error:
            "Team member not found.",
        });
      }

      await audit(
        req.user!.businessId,
        req.user!.id,
        "team_member_removed",
        "user",
        String(req.params.id),
        {
          name: r[0].name,
          email: r[0].email,
          role: r[0].role,
        }
      );

      res.json({
        ok: true,
        user: r[0],
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not remove team member.",
      });
    }
  }
);

app.patch(
  "/api/members/:id/permissions",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      if (
        req.params.id ===
        req.user!.id
      ) {
        return res.status(400).json({
          error:
            "Owner permissions are managed automatically.",
        });
      }

      const permissions =
        Array.isArray(
          req.body.permissions
        )
          ? req.body.permissions.filter(
              (p: unknown): p is Permission =>
                ALL_PERMISSIONS.includes(
                  p as Permission
                ) &&
                p !== "team" &&
                p !== "settings"
            )
          : [];

      const r = await sql`
        UPDATE users
        SET permissions =
          ${JSON.stringify(
            permissions
          )}::jsonb
        WHERE id = ${req.params.id}
          AND business_id = ${req.user!.businessId}
          AND role = 'worker'
        RETURNING id, name, email, permissions
      `;

      if (!r.length) {
        return res.status(404).json({
          error:
            "Employee not found.",
        });
      }

      await audit(
        req.user!.businessId,
        req.user!.id,
        "employee_permissions_updated",
        "user",
        String(req.params.id),
        { permissions }
      );

      res.json({
        ok: true,
        user: r[0],
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not update employee permissions.",
      });
    }
  }
);

app.get(
  "/api/members",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      const r = await sql`
        SELECT
          id,
          name,
          email,
          role,
          is_active AS "isActive",
          permissions,
          created_at AS "createdAt"
        FROM users
        WHERE business_id = ${req.user!.businessId}
        ORDER BY created_at
      `;

      res.json({
        members: r.map(
          (u: any) => ({
            ...u,
            permissions:
              permissionsForRole(
                u.role,
                u.permissions
              ),
          })
        ),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not load team.",
      });
    }
  }
);

app.get(
  "/api/audit",
  auth,
  owner,
  async (req: R, res) => {
    try {
      await schema();

      const r = await sql`
        SELECT
          a.id,
          a.action,
          a.entity_type AS "entityType",
          a.entity_id AS "entityId",
          a.details,
          a.created_at AS "createdAt",
          u.name AS "actorName"
        FROM audit_logs a
        LEFT JOIN users u
          ON u.id = a.actor_id
        WHERE a.business_id =
          ${req.user!.businessId}
        ORDER BY a.created_at DESC
        LIMIT 200
      `;

      res.json({ logs: r });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not load audit history.",
      });
    }
  }
);


/*
 * Agency banking: provider configuration
 */
const BANKING_PROVIDERS = [
  { name: "Equity Bank", code: "EQUITY" },
  { name: "KCB", code: "KCB" },
  { name: "Co-operative Bank", code: "COOP" },
  { name: "M-Pesa", code: "MPESA" },
  { name: "Airtel Money", code: "AIRTEL" },
];

app.get(
  "/api/banking/providers",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      for (const provider of BANKING_PROVIDERS) {
        await sql`
          INSERT INTO banking_providers
            (business_id, name, code, agent_number)
          VALUES
            (${req.user!.businessId}, ${provider.name},
             ${provider.code}, NULL)
          ON CONFLICT (business_id, code) DO NOTHING
        `;
      }

      const providers = await sql`
        SELECT
          id,
          name,
          code,
          agent_number AS "agentNumber",
          is_active AS "isActive"
        FROM banking_providers
        WHERE business_id = ${req.user!.businessId}
        ORDER BY name
      `;

      res.json({ providers });
    } catch (error) {
      console.error("Banking providers:", error);
      res.status(500).json({ error: "Could not load banking providers." });
    }
  }
);

app.patch(
  "/api/banking/providers/:id",
  auth,
  requirePermission("banking"),
  owner,
  async (req: R, res) => {
    try {
      await schema();

      const agentNumber =
        req.body.agentNumber === null ||
        req.body.agentNumber === ""
          ? null
          : typeof req.body.agentNumber === "string"
            ? req.body.agentNumber.trim()
            : undefined;

      if (
        agentNumber === undefined ||
        (agentNumber !== null && agentNumber.length > 50)
      ) {
        return res.status(400).json({
          error: "Enter a valid agent number or leave it blank.",
        });
      }

      if (typeof req.body.isActive !== "boolean") {
        return res.status(400).json({
          error: "Provider active status must be true or false.",
        });
      }

      const updated = await sql`
        UPDATE banking_providers
        SET
          agent_number = ${agentNumber},
          is_active = ${req.body.isActive},
          updated_at = NOW()
        WHERE id = ${req.params.id}
          AND business_id = ${req.user!.businessId}
        RETURNING id, name, code,
          agent_number AS "agentNumber",
          is_active AS "isActive"
      `;

      if (!updated.length) {
        return res.status(404).json({ error: "Provider not found." });
      }

      await audit(
        req.user!.businessId,
        req.user!.id,
        "update",
        "banking_provider",
        String(req.params.id),
        { agentNumber, isActive: req.body.isActive }
      );

      res.json({ provider: updated[0] });
    } catch (error) {
      console.error("Update banking provider:", error);
      res.status(500).json({ error: "Could not update provider settings." });
    }
  }
);


/*
 * Agency banking: transaction capture
 */
app.get(
  "/api/banking/transactions",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      const date =
        typeof req.query.date === "string" ? req.query.date : null;

      const transactions = await sql`
        SELECT
          t.id,
          t.transaction_id AS "transactionId",
          t.transaction_type AS type,
          t.customer_name AS "customerName",
          t.customer_phone AS "customerPhone",
          t.amount::float8 AS amount,
          t.commission::float8 AS commission,
          t.status,
          t.notes,
          t.created_at AS "createdAt",
          p.name AS "providerName",
          p.code AS "providerCode"
        FROM banking_transactions t
        JOIN banking_providers p ON p.id = t.provider_id
        WHERE t.business_id = ${req.user!.businessId}
          AND (${date}::date IS NULL OR t.created_at::date = ${date}::date)
        ORDER BY t.created_at DESC
        LIMIT 500
      `;

      res.json({ transactions });
    } catch (error) {
      console.error("Banking transactions:", error);
      res.status(500).json({ error: "Could not load banking transactions." });
    }
  }
);

app.post(
  "/api/banking/transactions",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      const {
        providerId,
        transactionId,
        type,
        customerName,
        customerPhone,
        notes,
      } = req.body;

      const amount = n(req.body.amount);
      const commission = n(req.body.commission ?? 0);
      const status = req.body.status ?? "completed";

      if (
        typeof providerId !== "string" ||
        typeof transactionId !== "string" ||
        !transactionId.trim() ||
        transactionId.trim().length > 120 ||
        !["deposit", "withdrawal"].includes(type) ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !Number.isFinite(commission) ||
        commission < 0 ||
        commission > amount ||
        !["pending", "completed", "failed", "reversed"].includes(status)
      ) {
        return res.status(400).json({
          error: "Check the provider, transaction ID, type, amount, commission and status.",
        });
      }

      if (
        (customerName != null &&
          (typeof customerName !== "string" || customerName.length > 150)) ||
        (customerPhone != null &&
          (typeof customerPhone !== "string" || customerPhone.length > 40)) ||
        (notes != null &&
          (typeof notes !== "string" || notes.length > 1000))
      ) {
        return res.status(400).json({ error: "Customer details or notes are invalid." });
      }

      const provider = await sql`
        SELECT id, name
        FROM banking_providers
        WHERE id = ${providerId}
          AND business_id = ${req.user!.businessId}
          AND is_active = true
        LIMIT 1
      `;

      if (!provider.length) {
        return res.status(400).json({
          error: "Select an active banking provider.",
        });
      }

      const inserted = await sql`
        INSERT INTO banking_transactions (
          business_id,
          provider_id,
          transaction_id,
          transaction_type,
          customer_name,
          customer_phone,
          amount,
          commission,
          status,
          notes,
          created_by
        )
        VALUES (
          ${req.user!.businessId},
          ${providerId},
          ${transactionId.trim()},
          ${type},
          ${customerName?.trim() || null},
          ${customerPhone?.trim() || null},
          ${amount},
          ${commission},
          ${status},
          ${notes?.trim() || null},
          ${req.user!.id}
        )
        RETURNING id
      `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        "create",
        "banking_transaction",
        String(inserted[0].id),
        {
          provider: provider[0].name,
          transactionId: transactionId.trim(),
          type,
          amount,
          commission,
          status,
        }
      );

      res.status(201).json({
        ok: true,
        id: inserted[0].id,
        message: "Banking transaction recorded.",
      });
    } catch (error: any) {
      if (error?.code === "23505") {
        return res.status(409).json({
          error: "This transaction ID has already been recorded for this provider.",
        });
      }

      console.error("Create banking transaction:", error);
      res.status(500).json({ error: "Could not record banking transaction." });
    }
  }
);


/*
 * Agency banking: float ledger and daily reconciliation
 */
app.get(
  "/api/banking/float",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      const providers = await sql`
        SELECT
          p.id AS "providerId",
          p.name AS "providerName",
          COALESCE(
            SUM(
              CASE
                WHEN f.direction = 'in' THEN f.amount
                ELSE -f.amount
              END
            ), 0
          )::float8 AS balance
        FROM banking_providers p
        LEFT JOIN banking_float_entries f
          ON f.provider_id = p.id
          AND f.business_id = p.business_id
        WHERE p.business_id = ${req.user!.businessId}
        GROUP BY p.id, p.name
        ORDER BY p.name
      `;

      const entries = await sql`
        SELECT
          f.id,
          f.provider_id AS "providerId",
          p.name AS "providerName",
          f.entry_type AS "entryType",
          f.direction,
          f.amount::float8 AS amount,
          f.reference,
          f.notes,
          f.created_at AS "createdAt"
        FROM banking_float_entries f
        JOIN banking_providers p ON p.id = f.provider_id
        WHERE f.business_id = ${req.user!.businessId}
        ORDER BY f.created_at DESC
        LIMIT 200
      `;

      res.json({ providers, entries });
    } catch (error) {
      console.error("Banking float:", error);
      res.status(500).json({ error: "Could not load float records." });
    }
  }
);

app.post(
  "/api/banking/float",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      const { providerId, entryType, direction, reference, notes } = req.body;
      const amount = n(req.body.amount);

      if (
        typeof providerId !== "string" ||
        !["opening", "deposit", "withdrawal", "adjustment"].includes(entryType) ||
        !["in", "out"].includes(direction) ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        (reference != null &&
          (typeof reference !== "string" || reference.length > 120)) ||
        (notes != null &&
          (typeof notes !== "string" || notes.length > 1000))
      ) {
        return res.status(400).json({ error: "Check the float entry details and amount." });
      }

      if (entryType === "opening" && direction !== "in") {
        return res.status(400).json({ error: "Opening float must be a money-in entry." });
      }

      const provider = await sql`
        SELECT id, name
        FROM banking_providers
        WHERE id = ${providerId}
          AND business_id = ${req.user!.businessId}
        LIMIT 1
      `;

      if (!provider.length) {
        return res.status(404).json({ error: "Provider not found." });
      }

      const inserted = await sql`
        INSERT INTO banking_float_entries (
          business_id, provider_id, entry_type, direction,
          amount, reference, notes, created_by
        )
        VALUES (
          ${req.user!.businessId}, ${providerId}, ${entryType},
          ${direction}, ${amount}, ${reference?.trim() || null},
          ${notes?.trim() || null}, ${req.user!.id}
        )
        RETURNING id
      `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        "create",
        "banking_float_entry",
        String(inserted[0].id),
        { provider: provider[0].name, entryType, direction, amount }
      );

      res.status(201).json({ ok: true, id: inserted[0].id });
    } catch (error) {
      console.error("Create float entry:", error);
      res.status(500).json({ error: "Could not record float movement." });
    }
  }
);

app.get(
  "/api/banking/summary",
  auth,
  requirePermission("banking"),
  async (req: R, res) => {
    try {
      await schema();

      const date =
        typeof req.query.date === "string" ? req.query.date : null;

      const totals = await sql`
        SELECT
          COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'deposit' AND status = 'completed'
          ), 0)::float8 AS deposits,
          COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'withdrawal' AND status = 'completed'
          ), 0)::float8 AS withdrawals,
          COALESCE(SUM(commission) FILTER (
            WHERE status = 'completed'
          ), 0)::float8 AS commission,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
          COUNT(*)::int AS "transactionCount"
        FROM banking_transactions
        WHERE business_id = ${req.user!.businessId}
          AND (${date}::date IS NULL OR created_at::date = ${date}::date)
      `;

      const closings = await sql`
        SELECT
          closing_date AS date,
          total_deposits::float8 AS deposits,
          total_withdrawals::float8 AS withdrawals,
          total_commission::float8 AS commission,
          expected_cash::float8 AS "expectedFloat",
          actual_cash::float8 AS "actualFloat",
          difference::float8 AS difference,
          closed_at AS "closedAt"
        FROM banking_daily_closings
        WHERE business_id = ${req.user!.businessId}
          AND (${date}::date IS NULL OR closing_date = ${date}::date)
        ORDER BY closing_date DESC
        LIMIT 30
      `;

      res.json({ summary: totals[0], closings });
    } catch (error) {
      console.error("Banking summary:", error);
      res.status(500).json({ error: "Could not load banking summary." });
    }
  }
);

app.post(
  "/api/banking/close",
  auth,
  requirePermission("banking"),
  owner,
  async (req: R, res) => {
    try {
      await schema();

      const date = req.body.date;
      const actualFloat = n(req.body.actualFloat);
      const notes = req.body.notes;

      if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(actualFloat) ||
        actualFloat < 0 ||
        (notes != null &&
          (typeof notes !== "string" || notes.length > 1000))
      ) {
        return res.status(400).json({ error: "Enter a valid closing date and actual float." });
      }

      const totals = await sql`
        SELECT
          COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'deposit' AND status = 'completed'
          ), 0)::numeric AS deposits,
          COALESCE(SUM(amount) FILTER (
            WHERE transaction_type = 'withdrawal' AND status = 'completed'
          ), 0)::numeric AS withdrawals,
          COALESCE(SUM(commission) FILTER (
            WHERE status = 'completed'
          ), 0)::numeric AS commission
        FROM banking_transactions
        WHERE business_id = ${req.user!.businessId}
          AND created_at::date = ${date}::date
      `;

      const float = await sql`
        SELECT
          COALESCE(SUM(
            CASE WHEN direction = 'in' THEN amount ELSE -amount END
          ), 0)::numeric AS balance
        FROM banking_float_entries
        WHERE business_id = ${req.user!.businessId}
          AND created_at::date <= ${date}::date
      `;

      const expectedFloat = Number(float[0].balance);
      const difference = actualFloat - expectedFloat;

      const closing = await sql`
        INSERT INTO banking_daily_closings (
          business_id, closing_date, total_deposits,
          total_withdrawals, total_commission,
          expected_cash, actual_cash, difference,
          notes, closed_by, closed_at
        )
        VALUES (
          ${req.user!.businessId}, ${date}::date,
          ${totals[0].deposits}, ${totals[0].withdrawals},
          ${totals[0].commission}, ${expectedFloat},
          ${actualFloat}, ${difference}, ${notes?.trim() || null},
          ${req.user!.id}, NOW()
        )
        ON CONFLICT (business_id, closing_date)
        DO UPDATE SET
          total_deposits = EXCLUDED.total_deposits,
          total_withdrawals = EXCLUDED.total_withdrawals,
          total_commission = EXCLUDED.total_commission,
          expected_cash = EXCLUDED.expected_cash,
          actual_cash = EXCLUDED.actual_cash,
          difference = EXCLUDED.difference,
          notes = EXCLUDED.notes,
          closed_by = EXCLUDED.closed_by,
          closed_at = NOW()
        RETURNING id, closing_date AS date,
          expected_cash::float8 AS "expectedFloat",
          actual_cash::float8 AS "actualFloat",
          difference::float8 AS difference
      `;

      await audit(
        req.user!.businessId,
        req.user!.id,
        "close",
        "banking_daily_closing",
        String(closing[0].id),
        { date, expectedFloat, actualFloat, difference }
      );

      res.json({ ok: true, closing: closing[0] });
    } catch (error) {
      console.error("Banking daily closing:", error);
      res.status(500).json({ error: "Could not complete daily reconciliation." });
    }
  }
);

app.use(
  (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error(err);

    res.status(500).json({
      error:
        "Unexpected server error.",
    });
  }
);

if (!process.env.VERCEL) {
  const port =
    Number(
      process.env.PORT ||
        3001
    );

  app.listen(
    port,
    "0.0.0.0",
    () => {
      console.log(
        `Kirathimo Agro Services API running on http://localhost:${port}`
      );
    }
  );
}

export default app;
