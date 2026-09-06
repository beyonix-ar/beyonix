import assert from "node:assert/strict"
import test from "node:test"
import { createClient } from "@supabase/supabase-js"
import { PDFDocument } from "pdf-lib"
import { cleanClaimOperation, claimErrorResponse, prepareClaimUploads, submitCustomerClaim } from "./claim-server.ts"

const actor="10000000-0000-4000-8000-000000000001"
const upload={name:"foto.jpg",type:"image/jpeg",size:3,bytes:new Uint8Array([255,216,255])}

function storageScenario(failure: "second-upload" | "commit" | "timeout-after-commit" | "cleanup" | "none") {
  let status="uploading"
  let filePaths:string[]=[]
  let uploadCount=0
  let commitCount=0
  const removed:string[]=[]
  const stored=new Set<string>()
  const admin=createClient("https://claims.example.test","test-key",{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:async (input,options) => {
      const url=new URL(String(input)), method=options?.method ?? "GET"
      const body=typeof options?.body==='string' ? JSON.parse(options.body) : {}
      const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})
      if(url.pathname.endsWith('/rpc/begin_order_claim_operation')) {
        filePaths=body.p_file_paths
        return reply({id:body.p_id,status,acquired:true})
      }
      if(url.pathname.includes('/storage/v1/object/') && method==='POST') {
        uploadCount++
        if(failure==='second-upload' && uploadCount===2) return reply({message:'storage internal path secret',statusCode:500},500)
        stored.add(url.pathname.split('/order-claim-evidence/')[1])
        return reply({Key:url.pathname})
      }
      if(url.pathname.endsWith('/rpc/commit_customer_order_claim')) {
        commitCount++
        if(failure==='commit' || failure==='cleanup') return reply({message:'internal SQL constraint secret',code:'XX000'},500)
        status='committed'
        if(failure==='timeout-after-commit') return reply({message:'gateway timeout',code:'XX000'},504)
        return reply(1)
      }
      if(url.pathname.endsWith('/order_claim_operations')) {
        if(method==='PATCH') {
          if(body.status==='failed' && status==='committed') return reply(null)
          status=body.status
          return reply({id:'operation'})
        }
        return reply({status,file_paths:filePaths,bucket_id:'order-claim-evidence',expires_at:'2026-09-06T12:00:00Z',claim_id:status==='committed'?1:null})
      }
      if(url.pathname.endsWith('/storage/v1/object/order-claim-evidence') && method==='DELETE') {
        if(failure==='cleanup') return reply({message:'cleanup unavailable',statusCode:500},500)
        for(const path of body.prefixes) { removed.push(path); stored.delete(path) }
        return reply([])
      }
      if(url.pathname.endsWith('/order_claims')) return reply({id:1,order_id:1,user_id:actor,status:'recibido',order_claim_files:[]})
      if(url.pathname.endsWith('/ordenes')) return reply({cliente_email:null})
      throw new Error('Unexpected test request '+url.pathname)
    }},
  })
  return {admin,removed,stored,get status(){return status},get commitCount(){return commitCount}}
}

test("Storage: segundo upload falla y limpia solamente paths reservados; no escribe reclamo",async()=>{
  const scenario=storageScenario('second-upload')
  const result=await submitCustomerClaim(scenario.admin,actor,1,{message:'Descripción suficiente'},[upload,upload])
  assert.equal(result.status,500)
  assert.equal(scenario.commitCount,0)
  assert.equal(scenario.stored.size,0)
  assert.equal(scenario.removed.length,2)
  assert.equal(scenario.status,'cleaned')
  assert.doesNotMatch(await result.text(),/secret|storage internal/)
})

test("Storage: fallo DB limpia objetos y conserva el intento para retry",async()=>{
  const scenario=storageScenario('commit')
  const result=await submitCustomerClaim(scenario.admin,actor,1,{message:'Descripción suficiente'},[upload])
  assert.equal(result.status,500)
  assert.equal(scenario.commitCount,1)
  assert.equal(scenario.stored.size,0)
  assert.equal(scenario.status,'cleaned')
})

test("Storage: timeout con commit confirmado nunca borra evidencia",async()=>{
  const scenario=storageScenario('timeout-after-commit')
  const result=await submitCustomerClaim(scenario.admin,actor,1,{message:'Descripción suficiente'},[upload])
  assert.equal(result.status,200)
  assert.equal(scenario.removed.length,0)
  assert.equal(scenario.stored.size,1)
  assert.equal(scenario.status,'committed')
})

test("Storage: limpieza fallida queda pendiente; no se declara limpiada",async()=>{
  const scenario=storageScenario('cleanup')
  await submitCustomerClaim(scenario.admin,actor,1,{message:'Descripción suficiente'},[upload])
  assert.equal(scenario.status,'failed')
  assert.equal(scenario.stored.size,1)
  assert.equal(await cleanClaimOperation(scenario.admin,'operation'),false)
})

test("archivos se validan completos antes de reservar o subir",async()=>{
  await assert.rejects(prepareClaimUploads([new File(['<html>falso</html>'],'fake.pdf',{type:'application/pdf'})]),/CLAIM_INVALID/)
  await assert.rejects(prepareClaimUploads([new File(['<svg onload=alert(1)>'],'fake.svg',{type:'image/svg+xml'})]),/CLAIM_INVALID/)
})

test("PDF parseable con JavaScript es rechazado; documento pasivo se conserva", async () => {
  const document = await PDFDocument.create()
  document.addPage()
  const safe = await document.save()
  assert.equal((await prepareClaimUploads([new File([new Uint8Array(safe)], "prueba.pdf", { type: "application/pdf" })])).length, 1)
  document.addJavaScript("evidencia", "app.alert('malicioso')")
  const active = await document.save()
  await assert.rejects(prepareClaimUploads([new File([new Uint8Array(active)], "prueba.pdf", { type: "application/pdf" })]), /CLAIM_INVALID/)
})

test("Storage: un limpiador tardío no finaliza la limpieza de un intento reutilizado", async () => {
  const expires = "2026-09-06T12:00:00Z"
  let conditionalUpdate = false
  const admin = createClient("https://claims.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, options) => {
      const url = new URL(String(input))
      if (options?.method === "PATCH") {
        conditionalUpdate = url.searchParams.get("expires_at") === `eq.${expires}`
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return Response.json({ status: "failed", file_paths: [], bucket_id: "order-claim-evidence", expires_at: expires })
    } },
  })
  assert.equal(await cleanClaimOperation(admin, "operation"), false)
  assert.equal(conditionalUpdate, true)
})

test("errores de SQL/Storage/stack no se exponen al navegador",async()=>{
  for(const error of [new Error('secret stack path'),{message:'violates order_claim_files_file_role_check',code:'23514'},null]) {
    const response=claimErrorResponse(error)
    assert.equal(response.status,500)
    assert.doesNotMatch(await response.text(),/secret|stack|path|constraint|23514|order_claim_files/)
  }
})
