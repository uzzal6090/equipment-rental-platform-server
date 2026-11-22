import { config as dotenvConfig } from "dotenv";
import * as dns from "dns";
import { MongoClient, ObjectId } from "mongodb";
import { spawn } from "child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import Stripe from "stripe";
import http from "http";
import { connectDB as connectAppDB, closeDB as closeAppDB, getClient } from "../src/config/db.js";

dotenvConfig({ path: ".env.test", override: true });
const dnsServers = process.env.DNS_SERVERS;
if (dnsServers) dns.setServers(dnsServers.split(",").map(s=>s.trim()).filter(Boolean));
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "equipment_rental_test_db";
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL;
const PORT = Number(process.env.PORT || 5011);
const BASE_URL = `http://localhost:${PORT}`;
if (DB_NAME !== "equipment_rental_test_db") { console.error("Unsafe DB"); process.exit(1); }

const results=[]; let passed=0, failed=0;
function test(name, fn){ return async()=>{ try{ await fn(); results.push({name,status:"PASS"}); passed++; console.log(`PASS: ${name}`);}catch(e){ results.push({name,status:"FAIL",error:e.message}); failed++; console.log(`FAIL: ${name} - ${e.message}`);} }; }
function assert(c,m){ if(!c) throw new Error(m); }
async function fetchJson(path, options={}){ const res=await fetch(`${BASE_URL}${path}`,{method:options.method||"GET",headers:{"Content-Type":"application/json",...(options.headers||{})},body:options.body}); const text=await res.text(); let body; try{ body=text?JSON.parse(text):null; }catch{ body=text; } return {status:res.status, body, headers:res.headers}; }
async function fetchRaw(path, options={}){ const res=await fetch(`${BASE_URL}${path}`,{method:options.method||"POST",headers:options.headers||{},body:options.body}); const text=await res.text(); let body; try{ body=text?JSON.parse(text):null; }catch{ body=text; } return {status:res.status, body, text}; }

let db, mongoClient, ownerProfileId, customerProfileId, customer2ProfileId, adminProfileId;
let ownerJwt, customerJwt, customer2Jwt, adminJwt;
let stripeMockServer, stripeMockRequests=[], stripeMockFail=false;

async function startStripeMock(){
  stripeMockRequests=[]; stripeMockFail=false;
  stripeMockServer = http.createServer(async (req,res)=>{
    let raw=""; req.on("data",c=>raw+=c); req.on("end",()=>{
      stripeMockRequests.push({method:req.method,url:req.url,body:raw,headers:req.headers});
      if (stripeMockFail) { res.writeHead(500,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:{message:"mock failure"}})); return; }
      if (req.method==="POST" && req.url.startsWith("/v1/checkout/sessions")){
        const params = new URLSearchParams(raw);
        const id = `cs_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const response={id,object:"checkout.session",url:`https://checkout.stripe.test/pay/${id}`,payment_status:"unpaid",amount_total:Number(params.get("line_items[0][price_data][unit_amount]")||10000),currency:params.get("line_items[0][price_data][currency]")||"usd",metadata:{checkout_intent_id:params.get("metadata[checkout_intent_id]"),equipment_id:params.get("metadata[equipment_id]"),user_id:params.get("metadata[user_id]"),owner_id:params.get("metadata[owner_id]")}};
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify(response)); return;
      }
      if (req.method==="POST" && /\/v1\/checkout\/sessions\/.*\/expire/.test(req.url)) {
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({id:req.url.split("/").pop(),status:"expired"})); return;
      }
      if (req.method==="GET" && req.url.startsWith("/v1/checkout/sessions/")) {
        const id=req.url.split("/").pop().split("?")[0];
        res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({id,object:"checkout.session",payment_status:"paid",metadata:{}})); return;
      }
      res.writeHead(404,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:{message:"not found"}}));
    });
  });
  await new Promise(r=>stripeMockServer.listen(12111,"127.0.0.1",r));
}
async function stopStripeMock(){ if(stripeMockServer) await new Promise(r=>stripeMockServer.close(r)); }

async function connectTestDb(){
  process.env.DB_NAME = DB_NAME;
  process.env.MONGODB_URI = MONGODB_URI;
  db = await connectAppDB();
  mongoClient = getClient();
  const name = db.databaseName;
  if (name !== "equipment_rental_test_db") throw new Error(`Unsafe db ${name}`);
}
async function clearDb(){
  for (const c of ["profiles","equipment","checkoutIntents","bookings","payments","webhookEvents","favorites","jwks"]) {
    await db.collection(c).deleteMany({});
  }
}
async function seed(){
  await clearDb();
  const profiles=[
    {betterAuthUserId:"owner1",name:"Owner",email:"o@e.com",role:"owner",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"cust1",name:"Cust1",email:"c1@e.com",role:"customer",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"cust2",name:"Cust2",email:"c2@e.com",role:"customer",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
    {betterAuthUserId:"admin1",name:"Admin",email:"a@e.com",role:"admin",roleVersion:0,createdAt:new Date(),updatedAt:new Date()},
  ];
  await db.collection("profiles").insertMany(profiles);
  const all = await db.collection("profiles").find({}).toArray();
  ownerProfileId=all.find(p=>p.role==="owner")._id;
  customerProfileId=all.find(p=>p.betterAuthUserId==="cust1")._id;
  customer2ProfileId=all.find(p=>p.betterAuthUserId==="cust2")._id;
  adminProfileId=all.find(p=>p.role==="admin")._id;
  const keyPair = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(keyPair.publicKey);
  const kid = "test-key-"+Date.now();
  await db.collection("jwks").insertOne({_id:kid,publicKey:JSON.stringify(jwk),privateKey:JSON.stringify(await exportJWK(keyPair.privateKey)),createdAt:new Date()});
  async function mk(role, sub, rv=0){ return new SignJWT({sub,role,roleVersion:rv}).setProtectedHeader({alg:"EdDSA",kid}).setIssuer(BETTER_AUTH_URL).setAudience(BETTER_AUTH_URL).setExpirationTime("1h").setIssuedAt().sign(keyPair.privateKey); }
  ownerJwt=await mk("owner","owner1",0); customerJwt=await mk("customer","cust1",0); customer2Jwt=await mk("customer","cust2",0); adminJwt=await mk("admin","admin1",0);
}
async function seedEquipment(overrides={}){
  const eq={ownerId:ownerProfileId,name:"Excavator",description:"d",category:"Construction Equipment",location:"NY",rentalPrice:100,rentalType:"daily",totalQuantity:1,condition:"good",status:"approved",featured:false,inventoryVersion:0,createdAt:new Date(),updatedAt:new Date(),...overrides};
  const r=await db.collection("equipment").insertOne(eq); return {...eq,_id:r.insertedId};
}

let serverProc;
async function startServer(){
  return new Promise((resolve,reject)=>{
    const proc=spawn("node",["server.js"],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),NODE_ENV:"test",DB_NAME,STRIPE_API_HOST:"127.0.0.1",STRIPE_API_PORT:"12111",STRIPE_API_PROTOCOL:"http",STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY||"sk_test_mock",STRIPE_WEBHOOK_SECRET:"whsec_test_phase41"},stdio:["ignore","pipe","pipe"]});
    let out=""; proc.stdout.on("data",d=>{out+=d.toString(); if(out.includes("Server running on port")) resolve(proc);});
    proc.stderr.on("data",d=>{out+=d.toString();});
    proc.on("error",reject);
    proc.on("exit",c=>{ if(c && c!==0) console.error(out.slice(-1000));});
    setTimeout(()=>reject(new Error("server timeout\n"+out.slice(-500))),30000);
  });
}
async function waitServer(){ for(let i=0;i<30;i++){ try{ const r=await fetch(`${BASE_URL}/`); if(r.ok) return; }catch{} await new Promise(r=>setTimeout(r,500)); } throw new Error("no server"); }

function future(daysFromNow, daysLen=2){ const s=new Date(); s.setDate(s.getDate()+daysFromNow); s.setHours(0,0,0,0); const e=new Date(s); e.setDate(e.getDate()+daysLen); return {startDate:s.toISOString(), endDate:e.toISOString()}; }
const tests=[
test("HTTP: authenticated customer can create valid booking", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:2});
  const d=future(10,2);
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1,contactPhone:"+1",deliveryAddress:"addr"})});
  assert(res.status===200, `Expected 200 got ${res.status}: ${JSON.stringify(res.body)}`);
  assert(res.body?.success===true, "success true");
  assert(res.body?.data?.checkoutUrl, "checkoutUrl present");
  const intents=await db.collection("checkoutIntents").find({equipmentId:eq._id}).toArray();
  assert(intents.length===1, "intent created");
  assert(intents[0].status==="pending", "pending");
}),
test("HTTP: unauthenticated user cannot create booking", async()=>{
  await seed(); const eq=await seedEquipment();
  const d=future(10,2);
  const res=await fetchJson("/api/bookings",{method:"POST",body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(res.status===401 || res.status===403, `Expected 401/403 got ${res.status}`);
}),
test("HTTP: invalid equipment ID rejected", async()=>{
  await seed();
  const d=future(10,2);
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:"bad-id",startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(res.status===400, `Expected 400 got ${res.status}`);
}),
test("HTTP: unapproved equipment cannot be booked", async()=>{
  await seed(); const eq=await seedEquipment({status:"pending"});
  const d=future(10,2);
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(res.status===400, `Expected 400 got ${res.status}: ${JSON.stringify(res.body)}`);
}),
test("HTTP: invalid rental dates rejected", async()=>{
  await seed(); const eq=await seedEquipment();
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:"2026-12-10",endDate:"2026-12-01",quantity:1})});
  assert(res.status===400, `Expected 400 got ${res.status}`);
}),
test("HTTP: invalid quantity rejected", async()=>{
  await seed(); const eq=await seedEquipment();
  const d=future(10,2);
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:0})});
  assert(res.status===400, `Expected 400 got ${res.status}`);
}),
test("HTTP: Stripe Checkout session creation failure releases inventory", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  stripeMockFail=true;
  const d=future(12,2);
  const res=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  stripeMockFail=false;
  assert(res.status>=400, `Expected failure got ${res.status}`);
  const pending=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending",released:{$ne:true}}).toArray();
  assert(pending.length===0, `No pending unreleased intent should remain, got ${pending.length}`);
  const res2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(res2.status===200, `Re-reserve should succeed got ${res2.status}: ${JSON.stringify(res2.body)}`);
}),
test("HTTP: customer cancellation releases inventory", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(14,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const cancel=await fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`}});
  assert(cancel.status===200, `cancel failed ${cancel.status}: ${JSON.stringify(cancel.body)}`);
  const after=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(after.status==="cancelled" && after.released===true, "intent cancelled/released");
  const res2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(res2.status===200, `re-reserve should succeed ${res2.status}`);
}),
test("HTTP: another customer cannot cancel someone else's intent", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(15,2);
  await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const cancel=await fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`}});
  assert(cancel.status===403, `Expected 403 got ${cancel.status}`);
}),
test("HTTP: repeated cancellation is safe", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(16,2);
  await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const c1=await fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`}});
  const c2=await fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`}});
  assert(c1.status===200, `first cancel ${c1.status}`);
  assert(c2.status===400 || c2.status===409, `second cancel should be safe rejection ${c2.status}`);
}),
test("HTTP: completed/paid intent cannot be cancelled", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(17,2);
  await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  await db.collection("checkoutIntents").updateOne({_id:intent._id},{$set:{status:"completed",released:true}});
  const cancel=await fetchJson(`/api/bookings/cancel/${intent._id}`,{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`}});
  assert(cancel.status===400 || cancel.status===409, `Expected 400/409 got ${cancel.status}`);
}),
test("HTTP: checkout status endpoint enforces authorization", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(18,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const sessionId=create.body.data.sessionId;
  const res=await fetchJson(`/api/bookings/checkout/${sessionId}`,{headers:{Authorization:`Bearer ${customer2Jwt}`}});
  assert([400,401,403,404].includes(res.status), `Expected authz rejection got ${res.status}`);
}),
test("HTTP: webhook rejects missing/invalid signatures", async()=>{
  await seed();
  const payload=JSON.stringify({id:"evt_bad",type:"checkout.session.completed",data:{object:{}}});
  const missing=await fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json"},body:payload});
  assert(missing.status===400, `missing sig expected 400 got ${missing.status}`);
  const invalid=await fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":"t=1,v1=bad"},body:payload});
  assert(invalid.status===400, `invalid sig expected 400 got ${invalid.status}`);
}),
test("HTTP: valid webhook uses raw-body signature verification and creates booking", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(19,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200, `create failed ${create.status}`);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY||"sk_test_mock",{apiVersion:"2024-04-10"});
  const payload = JSON.stringify({id:`evt_ok_${Date.now()}`,object:"event",type:"checkout.session.completed",data:{object:{id:`cs_ok_${Date.now()}`,object:"checkout.session",payment_status:"paid",amount_total:Math.round(intent.totalPrice*100),currency:"usd",payment_intent:`pi_ok_${Date.now()}`,metadata:{checkout_intent_id:intent._id.toString(),user_id:customerProfileId.toString(),equipment_id:eq._id.toString(),owner_id:ownerProfileId.toString()}}}});
  const sig = stripe.webhooks.generateTestHeaderString({payload,secret:"whsec_test_phase41"});
  const res=await fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload});
  assert(res.status===200, `Expected 200 got ${res.status}: ${res.text}`);
  const bookings=await db.collection("bookings").find({checkoutIntent:intent._id}).toArray();
  const payments=await db.collection("payments").find({checkoutIntent:intent._id}).toArray();
  assert(bookings.length===1, `one booking ${bookings.length}`);
  assert(payments.length===1, `one payment ${payments.length}`);
}),
test("HTTP: duplicate webhook delivery creates no duplicates", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(20,2);
  await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id});
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY||"sk_test_mock",{apiVersion:"2024-04-10"});
  const eventId=`evt_dup_${Date.now()}`;
  const payload=JSON.stringify({id:eventId,object:"event",type:"checkout.session.completed",data:{object:{id:`cs_dup_${Date.now()}`,object:"checkout.session",payment_status:"paid",amount_total:Math.round(intent.totalPrice*100),currency:"usd",payment_intent:`pi_dup_${Date.now()}`,metadata:{checkout_intent_id:intent._id.toString(),user_id:customerProfileId.toString(),equipment_id:eq._id.toString(),owner_id:ownerProfileId.toString()}}}});
  const sig=stripe.webhooks.generateTestHeaderString({payload,secret:"whsec_test_phase41"});
  const [r1,r2]=await Promise.all([
    fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload}),
    fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload}),
  ]);
  assert(r1.status===200 && r2.status===200, `statuses ${r1.status}/${r2.status}`);
  const bookings=await db.collection("bookings").find({checkoutIntent:intent._id}).toArray();
  const payments=await db.collection("payments").find({checkoutIntent:intent._id}).toArray();
  assert(bookings.length===1, `bookings ${bookings.length}`);
  assert(payments.length===1, `payments ${payments.length}`);
}),
test("HTTP: checkout.session.expired webhook releases pending intent exactly once and allows re-reserve", async()=>{
  await seed(); const eq=await seedEquipment({totalQuantity:1});
  const d=future(21,2);
  const create=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customerJwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(create.status===200, `create failed ${create.status}: ${JSON.stringify(create.body)}`);
  const intent=await db.collection("checkoutIntents").findOne({equipmentId:eq._id,status:"pending"});
  assert(intent, "pending intent exists");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY||"sk_test_mock",{apiVersion:"2024-04-10"});
  const eventId=`evt_expired_${Date.now()}`;
  const payload=JSON.stringify({id:eventId,object:"event",type:"checkout.session.expired",data:{object:{id:intent.stripeSessionId||`cs_exp_${Date.now()}`,object:"checkout.session",payment_status:"unpaid",metadata:{checkout_intent_id:intent._id.toString(),user_id:customerProfileId.toString(),equipment_id:eq._id.toString(),owner_id:ownerProfileId.toString()}}}});
  const sig=stripe.webhooks.generateTestHeaderString({payload,secret:"whsec_test_phase41"});
  const res=await fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload});
  assert(res.status===200, `Expected 200 got ${res.status}: ${res.text}`);
  const after=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(after.status==="expired", `intent status ${after.status}`);
  assert(after.released===true, "intent released");
  const bookings=await db.collection("bookings").find({checkoutIntent:intent._id}).toArray();
  const payments=await db.collection("payments").find({checkoutIntent:intent._id}).toArray();
  assert(bookings.length===0, "no booking created");
  assert(payments.length===0, "no payment created");

  // Replay same event - must not release twice / no state corruption
  const replay=await fetchRaw("/api/webhooks/stripe",{headers:{"Content-Type":"application/json","stripe-signature":sig},body:payload});
  assert(replay.status===200, `replay status ${replay.status}`);
  const afterReplay=await db.collection("checkoutIntents").findOne({_id:intent._id});
  assert(afterReplay.status==="expired" && afterReplay.released===true, "replay kept expired/released");

  // Overlapping booking should succeed after release
  const r2=await fetchJson("/api/bookings",{method:"POST",headers:{Authorization:`Bearer ${customer2Jwt}`},body:JSON.stringify({equipmentId:eq._id.toString(),startDate:d.startDate,endDate:d.endDate,quantity:1})});
  assert(r2.status===200, `re-reserve after expired webhook should succeed ${r2.status}: ${JSON.stringify(r2.body)}`);
  const active=await db.collection("checkoutIntents").find({equipmentId:eq._id,status:"pending",released:{$ne:true}}).toArray();
  assert(active.length===1, `one active pending intent ${active.length}`);
  assert(active[0].userId.toString()===customer2ProfileId.toString(), "new reservation belongs to customer2");
}),
];
async function main(){
  await startStripeMock();
  await connectTestDb();
  await clearDb();
  serverProc=await startServer();
  await waitServer();
  try {
    for (const t of tests) await t();
  } finally {
    if (serverProc) serverProc.kill();
    await closeAppDB().catch(()=>{});
    await stopStripeMock();
  }
  console.log(`\nTOTAL:${results.length} PASS:${passed} FAIL:${failed}`);
  for (const r of results.filter(r=>r.status==="FAIL")) console.log(`- ${r.name}: ${r.error}`);
  process.exit(failed?1:0);
}
main().catch(e=>{ console.error(e); process.exit(1); });
