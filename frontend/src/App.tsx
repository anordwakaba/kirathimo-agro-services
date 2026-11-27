import { FormEvent, useEffect, useState } from "react";

type User = { id:string; name:string; email:string; role:"owner"|"worker" };
type Item = { id:string; name:string; category:string; unit:string; stockQty:number; costPrice:number; sellingPrice:number; packSize:number; packLabel:string; packSellingPrice:number };
type Tx = { id:string; date:string; type:string; itemName?:string; quantity?:number; amount:number; paymentMethod:string; notes?:string };

const payments = ["Cash","M-Pesa","Equity","KCB","Co-op","Eco Bank","Other"];
const cats = ["Animal Feeds","Seedlings","Fertilizer","Pesticides","Veterinary","Tools","Other"];
const money = (n:number) => `KES ${Number(n||0).toLocaleString("en-KE",{minimumFractionDigits:2})}`;
const today = () => new Date().toISOString().slice(0,10);

async function api<T=any>(path:string, options:RequestInit={}) {
  const res = await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})},credentials:"include"});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data as T;
}

export default function App(){
  const [user,setUser]=useState<User|null|undefined>(undefined);
  const [tab,setTab]=useState("dashboard"),[date,setDate]=useState(today());
  const [items,setItems]=useState<Item[]>([]),[tx,setTx]=useState<Tx[]>([]),[summary,setSummary]=useState<any>({}),[error,setError]=useState("");

  async function refresh(){
    try{
      const me=await api<{user:User}>("/api/auth/me"); setUser(me.user);
      const [i,t,s]=await Promise.all([
        api<{items:Item[]}>("/api/items"),
        api<{items:Tx[]}>("/api/transactions?date="+date),
        api("/api/summary?date="+date)
      ]);
      setItems(i.items);setTx(t.items);setSummary(s);setError("");
    }catch(e:any){
      if(e.message==="Not authenticated") setUser(null); else setError(e.message);
    }
  }
  useEffect(()=>{refresh()},[]);
  useEffect(()=>{if(user) refresh()},[date]);
  useEffect(()=>{
    if(!user)return;
    const id=window.setInterval(refresh,5000);
    return()=>window.clearInterval(id);
  },[user,date]);

  if(user===undefined)return <div className="center">Loading KIRATHIMO…</div>;
  if(!user)return <Auth onDone={refresh}/>;

  const nav=[["dashboard","Dashboard"],["sales","Sales"],["purchases","Purchases"],["inventory","Inventory"],["reports","Reports"],...(user.role==="owner"? [["team","Team"]]:[])] as string[][];
  return <div className="app">
    <aside>
      <div className="brand"><div className="logo">KA</div><div><b>KIRATHIMO</b><small>AGRO SERVICES</small></div></div>
      {nav.map(([key,label])=><button key={key} className={tab===key?"active":""} onClick={()=>setTab(key)}>{label}</button>)}
      <div className="account"><b>{user.name}</b><small>{user.role}</small><button onClick={async()=>{await api("/api/auth/logout",{method:"POST"});setUser(null)}}>Sign out</button></div>
    </aside>
    <main>
      <header><div><h1>{tab[0].toUpperCase()+tab.slice(1)}</h1><p>Shared data • refreshes every 5 seconds</p></div><input type="date" value={date} onChange={e=>setDate(e.target.value)}/></header>
      {error&&<div className="notice">{error}</div>}
      {tab==="dashboard"&&<Dashboard s={summary} tx={tx}/>}
      {tab==="sales"&&<Entry type="sale" items={items} onSaved={refresh}/>}
      {tab==="purchases"&&<Entry type="purchase" items={items} onSaved={refresh}/>}
      {tab==="inventory"&&<Inventory items={items} owner={user.role==="owner"} onSaved={refresh}/>}
      {tab==="reports"&&<Report s={summary} tx={tx} date={date}/>}
      {tab==="team"&&user.role==="owner"&&<Team/>}
    </main>
  </div>;
}

function Auth({onDone}:{onDone:()=>void}){
  const [mode,setMode]=useState<"login"|"register">("login"),[f,setF]=useState({name:"",email:"",password:""}),[msg,setMsg]=useState("");
  async function submit(e:FormEvent){e.preventDefault();setMsg("");try{await api(mode==="login"?"/api/auth/login":"/api/auth/register",{method:"POST",body:JSON.stringify(f)});onDone()}catch(e:any){setMsg(e.message)}}
  return <div className="login"><section className="card login-card"><div className="logo">KA</div><h1>KIRATHIMO AGRO SERVICES</h1><p>Sales, stock, payments and daily profit/loss.</p>
    <div className="tabs"><button className={mode==="login"?"selected":""} onClick={()=>setMode("login")}>Sign in</button><button className={mode==="register"?"selected":""} onClick={()=>setMode("register")}>First setup</button></div>
    <form onSubmit={submit}>{mode==="register"&&<label>Owner name<input required value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></label>}<label>Email<input type="email" required value={f.email} onChange={e=>setF({...f,email:e.target.value})}/></label><label>Password<input type="password" minLength={8} required value={f.password} onChange={e=>setF({...f,password:e.target.value})}/></label><button className="primary">{mode==="login"?"Sign in":"Create owner account"}</button></form>
    <p className="hint">First setup works only when there are no users.</p>{msg&&<div className="error">{msg}</div>}
  </section></div>;
}

function Dashboard({s,tx}:{s:any;tx:Tx[]}){return <><div className="metrics"><M l="Sales" v={money(s.sales)}/><M l="COGS" v={money(s.cogs)}/><M l="Expenses" v={money(s.expenses)}/><M l={s.netProfit>=0?"Profit":"Loss"} v={money(Math.abs(s.netProfit))}/><M l="Cash movement" v={money(s.cashMovement)}/></div><div className="grid"><section className="card"><h2>Payment channels</h2>{payments.map(p=><div className="pay" key={p}><span>{p}</span><b>{money(s.byPayment?.[p]||0)}</b></div>)}</section><section className="card"><h2>Transactions</h2><Table tx={tx.slice(0,12)}/></section></div></>}
function M({l,v}:{l:string;v:string}){return <div className="metric"><span>{l}</span><strong>{v}</strong></div>}

function Entry({type,items,onSaved}:{type:"sale"|"purchase";items:Item[];onSaved:()=>void}){
  const [f,setF]=useState({itemId:"",quantity:"1",unitPrice:"",paymentMethod:"M-Pesa",date:today(),notes:"",saleUnit:"base"});
  const [msg,setMsg]=useState("");
  const item=items.find(i=>i.id===f.itemId);
  const packSize=Math.max(Number(item?.packSize||1),0.001);
  const packPrice=Number(item?.packSellingPrice||0)>0?Number(item?.packSellingPrice):Number(item?.sellingPrice||0)*packSize;
  const isPack=type==="sale"&&f.saleUnit==="pack";
  const entered=Number(f.quantity||0);
  const baseQuantity=isPack?entered*packSize:entered;
  const basePrice=isPack?Number(f.unitPrice||0)/packSize:Number(f.unitPrice||0);
  const total=entered*Number(f.unitPrice||0);

  function choose(id:string){
    const i=items.find(x=>x.id===id);
    setF({...f,itemId:id,unitPrice:String(type==="sale"?i?.sellingPrice||0:i?.costPrice||0),saleUnit:"base"});
    setMsg("");
  }

  function changeSaleUnit(unit:"base"|"pack"){
    if(!item)return;
    setF({...f,saleUnit:unit,unitPrice:String(unit==="pack"?packPrice:item.sellingPrice)});
  }

  async function submit(e:FormEvent){
    e.preventDefault();
    setMsg("");
    if(!item){setMsg("Select an item.");return}
    if(!Number.isFinite(entered)||entered<=0||!Number.isFinite(basePrice)||basePrice<=0){setMsg("Enter a valid quantity and price.");return}
    if(type==="sale"&&baseQuantity>item.stockQty+0.000001){setMsg(`Not enough stock. Available: ${item.stockQty} ${item.unit}.`);return}
    try{
      await api("/api/transactions",{method:"POST",body:JSON.stringify({...f,type,quantity:baseQuantity,unitPrice:basePrice})});
      setMsg("Saved successfully.");
      setF({...f,itemId:"",quantity:"1",unitPrice:"",saleUnit:"base"});
      onSaved();
    }catch(e:any){setMsg(e.message)}
  }

  return <section className="card form"><h2>Record {type}</h2><form onSubmit={submit}>
    <label>Item<select required value={f.itemId} onChange={e=>choose(e.target.value)}>
      <option value="">Select item</option>
      {items.map(i=><option key={i.id} value={i.id} disabled={type==="sale"&&i.stockQty<=0}>
        {i.name} • {i.stockQty<=0?"OUT OF STOCK":`${i.stockQty} ${i.unit} available`}
      </option>)}
    </select></label>

    {item&&type==="sale"&&<label>Sell as
      <select value={f.saleUnit} onChange={e=>changeSaleUnit(e.target.value as "base"|"pack")}>
        <option value="base">By {item.unit}</option>
        <option value="pack">{item.packLabel} ({item.packSize} {item.unit})</option>
      </select>
    </label>}

    <div className="two">
      <label>Quantity<input type="number" min="0.001" step="0.001"
        max={type==="sale"&&item?(isPack?item.stockQty/packSize:item.stockQty):undefined}
        required value={f.quantity} onChange={e=>setF({...f,quantity:e.target.value})}/></label>
      <label>{isPack?`${item?.packLabel||"Package"} price (KES)`:`Price per ${item?.unit||"unit"} (KES)`}
        <input type="number" min="0.01" step="0.01" required value={f.unitPrice}
          onChange={e=>setF({...f,unitPrice:e.target.value})}/>
      </label>
    </div>

    {item&&<p className="hint">
      {type==="sale"
        ?`Available: ${item.stockQty} ${item.unit}. This sale deducts ${baseQuantity.toLocaleString()} ${item.unit}.`
        :`This purchase adds ${baseQuantity.toLocaleString()} ${item.unit} to stock.`}
    </p>}

    <div className="two">
      <label>Payment<select value={f.paymentMethod} onChange={e=>setF({...f,paymentMethod:e.target.value})}>
        {payments.map(p=><option key={p}>{p}</option>)}
      </select></label>
      <label>Date<input type="date" required value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></label>
    </div>
    <label>Notes<input value={f.notes} onChange={e=>setF({...f,notes:e.target.value})}/></label>
    <div className="total">Total <b>{money(total)}</b></div>
    <button className="primary">Save {type}</button>
    {msg&&<div className={msg.startsWith("Saved")?"success":"error"}>{msg}</div>}
    {item&&type==="sale"&&<p className="hint">Estimated gross profit: {money((basePrice-item.costPrice)*baseQuantity)}</p>}
  </form></section>
}

function Inventory({items,owner,onSaved}:{items:Item[];owner:boolean;onSaved:()=>void}){
  const blank={name:"",category:"Animal Feeds",unit:"kg",stockQty:"0",costPrice:"0",sellingPrice:"0",packLabel:"bag",packSize:"50",packSellingPrice:""};
  const [f,setF]=useState(blank),[editing,setEditing]=useState<string|null>(null),[filter,setFilter]=useState("all"),[msg,setMsg]=useState("");

  async function submit(e:FormEvent){
    e.preventDefault();setMsg("");
    const stockQty=Number(f.stockQty),costPrice=Number(f.costPrice),sellingPrice=Number(f.sellingPrice),packSize=Number(f.packSize),packSellingPrice=Number(f.packSellingPrice||0);
    if(!Number.isFinite(packSize)||packSize<=0){setMsg("Package size must be greater than zero.");return}
    if([stockQty,costPrice,sellingPrice,packSellingPrice].some(x=>!Number.isFinite(x)||x<0)){setMsg("Enter valid non-negative stock and prices.");return}
    try{
      const body={...f,stockQty,costPrice,sellingPrice,packSize,packSellingPrice};
      if(editing)await api("/api/items/"+editing,{method:"PUT",body:JSON.stringify(body)});
      else await api("/api/items",{method:"POST",body:JSON.stringify(body)});
      setF(blank);setEditing(null);setMsg("Saved successfully.");onSaved();
    }catch(e:any){setMsg(e.message)}
  }

  const ins=items.filter(i=>i.stockQty>0),outs=items.filter(i=>i.stockQty<=0),visible=filter==="in"?ins:filter==="out"?outs:items;

  return <div>
    <div className="metrics"><M l="Total items" v={String(items.length)}/><M l="In stock" v={String(ins.length)}/><M l="Out of stock" v={String(outs.length)}/></div>
    <div className="grid">
      {owner&&<section className="card form"><h2>{editing?"Update item":"Add farm item"}</h2>
        <form onSubmit={submit}>
          <label>Item name<input required value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></label>
          <div className="two">
            <label>Category<select value={f.category} onChange={e=>setF({...f,category:e.target.value})}>{cats.map(c=><option key={c}>{c}</option>)}</select></label>
            <label>Base unit<input required placeholder="kg, litre, piece, bottle..." value={f.unit} onChange={e=>setF({...f,unit:e.target.value})}/></label>
          </div>
          <label>Available stock (base units)<input type="number" min="0" step="0.001" required value={f.stockQty} onChange={e=>setF({...f,stockQty:e.target.value})}/></label>
          <div className="two">
            <label>Buying cost per {f.unit||"unit"} (KES)<input type="number" min="0" step="0.01" required value={f.costPrice} onChange={e=>setF({...f,costPrice:e.target.value})}/></label>
            <label>Selling price per {f.unit||"unit"} (KES)<input type="number" min="0" step="0.01" required value={f.sellingPrice} onChange={e=>setF({...f,sellingPrice:e.target.value})}/></label>
          </div>
          <h3>Package settings</h3>
          <div className="two">
            <label>Package name<input required placeholder="bag, bottle, box..." value={f.packLabel} onChange={e=>setF({...f,packLabel:e.target.value})}/></label>
            <label>Quantity per package<input type="number" min="0.001" step="0.001" required value={f.packSize} onChange={e=>setF({...f,packSize:e.target.value})}/></label>
          </div>
          <label>Price for one complete package (KES)<input type="number" min="0" step="0.01" value={f.packSellingPrice} onChange={e=>setF({...f,packSellingPrice:e.target.value})}/></label>
          <p className="hint">Leave the package price blank or zero to calculate it using the base-unit selling price.</p>
          <div className="two">
            <button className="primary">{editing?"Save changes":"Add item"}</button>
            {editing&&<button type="button" onClick={()=>{setEditing(null);setF(blank);setMsg("")}}>Cancel</button>}
          </div>
          {msg&&<div className={msg.startsWith("Saved")?"success":"error"}>{msg}</div>}
        </form>
      </section>}

      <section className="card"><h2>Stock list</h2>
        <div className="filters">
          <button className={filter==="all"?"primary":""} onClick={()=>setFilter("all")}>All ({items.length})</button>
          <button className={filter==="in"?"primary":""} onClick={()=>setFilter("in")}>In stock ({ins.length})</button>
          <button className={filter==="out"?"primary":""} onClick={()=>setFilter("out")}>Out ({outs.length})</button>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Item</th><th>Category</th><th>Stock</th><th>Cost / unit</th><th>Sell / unit</th><th>Status</th>{owner&&<th></th>}</tr></thead>
          <tbody>{visible.map(i=><tr key={i.id}>
            <td>{i.name}<small style={{display:"block"}}>{i.packLabel}: {i.packSize} {i.unit}</small></td>
            <td>{i.category}</td>
            <td>{i.stockQty} {i.unit}<small style={{display:"block"}}>{i.packSize>0?(i.stockQty/i.packSize).toFixed(2):"0"} {i.packLabel}(s)</small></td>
            <td>{money(i.costPrice)}</td><td>{money(i.sellingPrice)}</td>
            <td><span className={`badge ${i.stockQty>0?"in":"out"}`}>{i.stockQty>0?"IN STOCK":"OUT OF STOCK"}</span></td>
            {owner&&<td><button onClick={()=>{setEditing(i.id);setMsg("");setF({
              name:i.name,category:i.category,unit:i.unit,stockQty:String(i.stockQty),costPrice:String(i.costPrice),sellingPrice:String(i.sellingPrice),
              packLabel:i.packLabel||"pack",packSize:String(i.packSize||1),packSellingPrice:String(i.packSellingPrice||"")
            })}}>Edit</button></td>}
          </tr>)}</tbody></table></div>
      </section>
    </div>
  </div>
}

function Report({s,tx,date}:{s:any;tx:Tx[];date:string}){return <section className="card"><div className="report-head"><div><h2>Daily Profit & Loss</h2><p>{date}</p></div><button onClick={()=>window.print()}>Print</button></div><div className="report"><div>Sales<b>{money(s.sales)}</b></div><div>Cost of goods sold<b>{money(s.cogs)}</b></div><div>Expenses<b>{money(s.expenses)}</b></div><div>{s.netProfit>=0?"Net profit":"Net loss"}<b>{money(Math.abs(s.netProfit))}</b></div></div><Table tx={tx}/></section>}
function Table({tx}:{tx:Tx[]}){return <div className="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Item</th><th>Qty</th><th>Amount</th><th>Payment</th></tr></thead><tbody>{tx.map(t=><tr key={t.id}><td>{t.date}</td><td>{t.type}</td><td>{t.itemName||t.notes||"—"}</td><td>{t.quantity||"—"}</td><td>{money(t.amount)}</td><td>{t.paymentMethod}</td></tr>)}</tbody></table></div>}

function Team(){const[f,setF]=useState({name:"",email:"",role:"worker"}),[msg,setMsg]=useState("");async function submit(e:FormEvent){e.preventDefault();try{await api("/api/members",{method:"POST",body:JSON.stringify(f)});setF({name:"",email:"",role:"worker"});setMsg("Invitation created.")}catch(e:any){setMsg(e.message)}}return <section className="card form"><h2>Team access</h2><p>Add the worker or second owner. They register using the invited email.</p><form onSubmit={submit}><label>Name<input required value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></label><label>Email<input type="email" required value={f.email} onChange={e=>setF({...f,email:e.target.value})}/></label><label>Role<select value={f.role} onChange={e=>setF({...f,role:e.target.value})}><option value="worker">Worker</option><option value="owner">Owner</option></select></label><button className="primary">Create invitation</button>{msg&&<div className={msg.includes("created")?"success":"error"}>{msg}</div>}</form></section>}
