import express, { Request, Response, NextFunction } from "express";
import { neon } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const app=express();app.use(express.json({limit:"1mb"}));
const sql=neon(process.env.DATABASE_URL||"");const SECRET=process.env.JWT_SECRET||"";
let ready:Promise<void>|null=null;

async function schema(){
  if(ready)return ready;
  ready=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','worker')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS invitations(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','worker')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Other',unit TEXT NOT NULL,stock_qty NUMERIC(14,2) NOT NULL DEFAULT 0,cost_price NUMERIC(14,2) NOT NULL DEFAULT 0,selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS transactions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),date DATE NOT NULL,type TEXT NOT NULL CHECK(type IN ('sale','purchase','expense','cash_in','cash_out')),item_id UUID REFERENCES items(id) ON DELETE SET NULL,item_name TEXT,quantity NUMERIC(14,2) NOT NULL DEFAULT 0,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,amount NUMERIC(14,2) NOT NULL CHECK(amount>0),cogs NUMERIC(14,2) NOT NULL DEFAULT 0,payment_method TEXT NOT NULL DEFAULT 'Cash',notes TEXT,created_by UUID REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions(date)`;
  })().catch(e=>{ready=null;throw e});return ready;
}
type User={id:string;name:string;email:string;role:"owner"|"worker"};type R=Request&{user?:User};
function token(req:Request){const h=req.headers.authorization;if(h?.startsWith("Bearer "))return h.slice(7);const c=req.headers.cookie||"";return c.match(/(?:^|; )ka_token=([^;]+)/)?.[1]}
function auth(req:R,res:Response,next:NextFunction){try{if(!SECRET)throw Error();const t=token(req);if(!t)throw Error();const p:any=jwt.verify(t,SECRET);req.user={id:p.sub,name:p.name,email:p.email,role:p.role};next()}catch{return res.status(401).json({error:"Not authenticated"})}}
function owner(req:R,res:Response,next:NextFunction){if(req.user?.role!=="owner")return res.status(403).json({error:"Only owners can do this"});next()}
function n(v:any){const x=Number(v);return Number.isFinite(x)?x:NaN}
const cookie=(t:string)=>`ka_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
const clear="ka_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

app.get("/api/health",async(_req,res)=>{try{await schema();res.json({ok:true})}catch{res.status(500).json({ok:false})}});
app.post("/api/auth/register",async(req,res)=>{
  try{await schema();const count=await sql`SELECT COUNT(*)::int AS c FROM users`;const name=String(req.body.name||"").trim(),email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
    if(name.length<2||!email.includes("@")||password.length<8)return res.status(400).json({error:"Name, valid email and password of at least 8 characters are required."});
    let role:"owner"|"worker"="owner";
    if(Number(count[0].c)>0){const inv=await sql`SELECT id,role FROM invitations WHERE email=${email}`;if(!inv.length)return res.status(403).json({error:"Registration is closed. Ask an owner to invite this email."});role=inv[0].role;await sql`DELETE FROM invitations WHERE id=${inv[0].id}`}
    const hash=await bcrypt.hash(password,12);const rows=await sql`INSERT INTO users(name,email,password_hash,role) VALUES(${name},${email},${hash},${role}) RETURNING id,name,email,role`;const u=rows[0] as User;res.setHeader("Set-Cookie",cookie(jwt.sign({sub:u.id,name:u.name,email:u.email,role:u.role},SECRET,{expiresIn:"7d"})));res.status(201).json({user:u})
  }catch(e:any){if(String(e.message).includes("duplicate"))return res.status(409).json({error:"That email is already registered."});res.status(500).json({error:"Could not create account."})}
});
app.post("/api/auth/login",async(req,res)=>{try{await schema();const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");const r=await sql`SELECT id,name,email,password_hash,role FROM users WHERE email=${email}`;if(!r.length||!(await bcrypt.compare(password,r[0].password_hash)))return res.status(401).json({error:"Incorrect email or password."});const u=r[0] as User;res.setHeader("Set-Cookie",cookie(jwt.sign({sub:u.id,name:u.name,email:u.email,role:u.role},SECRET,{expiresIn:"7d"})));res.json({user:u})}catch{res.status(500).json({error:"Login failed."})}});
app.post("/api/auth/logout",(_req,res)=>{res.setHeader("Set-Cookie",clear);res.json({ok:true})});
app.get("/api/auth/me",auth,(req:R,res)=>res.json({user:req.user}));

app.get("/api/items",auth,async(_req,res)=>{try{await schema();const r=await sql`SELECT id,name,category,unit,stock_qty::float8 AS "stockQty",cost_price::float8 AS "costPrice",selling_price::float8 AS "sellingPrice" FROM items ORDER BY name`;res.json({items:r})}catch{res.status(500).json({error:"Could not load inventory."})}});
app.post("/api/items",auth,owner,async(req:R,res)=>{try{await schema();const name=String(req.body.name||"").trim(),unit=String(req.body.unit||"").trim(),stock=n(req.body.stockQty),cost=n(req.body.costPrice),sell=n(req.body.sellingPrice);if(!name||!unit||[stock,cost,sell].some(x=>!Number.isFinite(x)||x<0))return res.status(400).json({error:"Enter valid non-negative stock and prices."});const r=await sql`INSERT INTO items(name,category,unit,stock_qty,cost_price,selling_price) VALUES(${name},${String(req.body.category||"Other")},${unit},${stock},${cost},${sell}) RETURNING id`;res.status(201).json({id:r[0].id})}catch{res.status(500).json({error:"Could not add item."})}});
app.put("/api/items/:id",auth,owner,async(req:R,res)=>{try{await schema();const name=String(req.body.name||"").trim(),unit=String(req.body.unit||"").trim(),stock=n(req.body.stockQty),cost=n(req.body.costPrice),sell=n(req.body.sellingPrice);if(!name||!unit||[stock,cost,sell].some(x=>!Number.isFinite(x)||x<0))return res.status(400).json({error:"Enter valid non-negative stock and prices."});const r=await sql`UPDATE items SET name=${name},category=${String(req.body.category||"Other")},unit=${unit},stock_qty=${stock},cost_price=${cost},selling_price=${sell},updated_at=NOW() WHERE id=${req.params.id} RETURNING id`;if(!r.length)return res.status(404).json({error:"Item not found."});res.json({ok:true})}catch{res.status(500).json({error:"Could not update item."})}});

app.get("/api/transactions",auth,async(req,res)=>{try{await schema();const d=String(req.query.date||new Date().toISOString().slice(0,10));const r=await sql`SELECT id,date::text,type,item_name AS "itemName",quantity::float8,amount::float8,cogs::float8,payment_method AS "paymentMethod",notes FROM transactions WHERE date=${d} ORDER BY created_at DESC LIMIT 200`;res.json({items:r})}catch{res.status(500).json({error:"Could not load transactions."})}});
app.post("/api/transactions",auth,async(req:R,res)=>{
  try{await schema();const type=String(req.body.type),q=n(req.body.quantity),p=n(req.body.unitPrice),date=String(req.body.date||new Date().toISOString().slice(0,10)),pay=String(req.body.paymentMethod||"Cash"),notes=String(req.body.notes||"");
    if(!["sale","purchase","expense","cash_in","cash_out"].includes(type))return res.status(400).json({error:"Invalid transaction type."});
    if(type==="sale"||type==="purchase"){
      if(!req.body.itemId||!Number.isFinite(q)||q<=0||!Number.isFinite(p)||p<=0)return res.status(400).json({error:"Item, quantity and price are required."});
      const it=await sql`SELECT id,name,stock_qty::float8 AS stock,cost_price::float8 AS cost FROM items WHERE id=${req.body.itemId}`;if(!it.length)return res.status(404).json({error:"Item not found."});
      let cogs=0;
      if(type==="sale"){if(Number(it[0].stock)<q)return res.status(400).json({error:`Not enough stock. Available: ${it[0].stock}.`});cogs=q*Number(it[0].cost);const u=await sql`UPDATE items SET stock_qty=stock_qty-${q},updated_at=NOW() WHERE id=${req.body.itemId} AND stock_qty>=${q} RETURNING id`;if(!u.length)return res.status(409).json({error:"Stock changed on another device. Refresh and try again."})}
      else{await sql`UPDATE items SET stock_qty=stock_qty+${q},updated_at=NOW() WHERE id=${req.body.itemId}`}
      const amount=q*p;const r=await sql`INSERT INTO transactions(date,type,item_id,item_name,quantity,unit_price,amount,cogs,payment_method,notes,created_by) VALUES(${date},${type},${req.body.itemId},${it[0].name},${q},${p},${amount},${cogs},${pay},${notes},${req.user!.id}) RETURNING id`;return res.status(201).json({id:r[0].id});
    }
    if(!Number.isFinite(p)||p<=0)return res.status(400).json({error:"Amount must be greater than zero."});const r=await sql`INSERT INTO transactions(date,type,quantity,unit_price,amount,payment_method,notes,created_by) VALUES(${date},${type},1,${p},${p},${pay},${notes},${req.user!.id}) RETURNING id`;res.status(201).json({id:r[0].id})
  }catch(e){console.error(e);res.status(500).json({error:"Could not save transaction."})}
});
app.get("/api/summary",auth,async(req,res)=>{try{await schema();const d=String(req.query.date||new Date().toISOString().slice(0,10));const r=await sql`SELECT type,amount::float8,cogs::float8,payment_method AS "paymentMethod" FROM transactions WHERE date=${d}`;let sales=0,cogs=0,expenses=0,cashMovement=0;const byPayment:Record<string,number>={};for(const x of r){const a=Number(x.amount);if(x.type==="sale"){sales+=a;cogs+=Number(x.cogs);cashMovement+=a}else if(x.type==="purchase"){cashMovement-=a}else if(x.type==="expense"){expenses+=a;cashMovement-=a}else if(x.type==="cash_in"){cashMovement+=a}else if(x.type==="cash_out"){cashMovement-=a}const sign=["purchase","expense","cash_out"].includes(x.type)?-1:1;byPayment[x.paymentMethod]=(byPayment[x.paymentMethod]||0)+sign*a}res.json({sales,cogs,expenses,netProfit:sales-cogs-expenses,cashMovement,byPayment})}catch{res.status(500).json({error:"Could not calculate report."})}});

app.post("/api/members",auth,owner,async(req:R,res)=>{try{await schema();const email=String(req.body.email||"").trim().toLowerCase(),name=String(req.body.name||"").trim(),role=req.body.role==="owner"?"owner":"worker";if(!name||!email.includes("@"))return res.status(400).json({error:"Valid name and email are required."});const exists=await sql`SELECT id FROM users WHERE email=${email}`;if(exists.length)return res.status(409).json({error:"That email is already registered."});await sql`INSERT INTO invitations(email,name,role) VALUES(${email},${name},${role}) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role`;res.status(201).json({ok:true})}catch{res.status(500).json({error:"Could not create invitation."})}});
app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{console.error(err);res.status(500).json({error:"Unexpected server error."})});
export default app;