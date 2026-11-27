import express, { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const sql = neon(process.env.DATABASE_URL || "");
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
      role = "worker";
      permissions = permissionsForRole(
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

      const permissions = Array.isArray(
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
            'worker',
            ${req.user!.businessId},
            ${JSON.stringify(permissions)}::jsonb,
            ${hash},
            ${expires},
            NULL
          )
          ON CONFLICT(email)
          DO UPDATE SET
            name = EXCLUDED.name,
            role = 'worker',
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

      /*
       * Email delivery will be connected in the next phase.
       * Returning the URL lets the owner test the invitation
       * workflow before configuring an email provider.
       */
      const invitationUrl =
        `/invite?token=${rawToken}`;

      res.status(201).json({
        ok: true,
        invitationUrl,
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
            "Employee not found.",
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
