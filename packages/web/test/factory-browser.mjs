/* global document, localStorage, innerWidth, navigator */
// Synthetic transport proof only. Run against a local production build with the public results snapshot.
// node test/factory-browser.mjs <playwright-index.mjs> <chromium> <origin> <output-dir> <results-repository>
import fs from "node:fs";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { pathToFileURL, URL } from "node:url";
import { join } from "node:path";
const [modulePath, executablePath, origin, outputDir, resultsRepository] = process.argv.slice(2);
if (!modulePath || !executablePath || !origin || !outputDir || !resultsRepository) throw new Error("Provide Playwright module, Chromium, local origin, output directory and public results repository.");
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("Browser fixture proof requires a local server.");
const { chromium } = await import(pathToFileURL(modulePath).href);
fs.mkdirSync(outputDir, { recursive: true });
const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/factory-v1/${name}.json`, import.meta.url), "utf8"));
(async()=>{
 const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
 for(const resumedWidth of [1440,390]) {
  const resumed=await browser.newContext({viewport:{width:resumedWidth,height:1000}});
  const saved=fixture('status-fulfilled');const writes=[];let validationFinished=false;
  await resumed.addInitScript(id=>{localStorage.setItem('rbw-factory-request-id',id);},saved.request_id);
  await resumed.route('**/api/factory/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(request.method()!=='GET')writes.push(path);
   let body;
   if(path.endsWith('/capabilities'))body=fixture('capabilities');
   else if(path.endsWith('/session'))body=fixture('session');
   else if(path.includes('/requests/')){
    body=fixture('status-fulfilled');
    body.cases[0].validation=fixture(validationFinished?'validation-passed':'validation-running');
   }else return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify(fixture('error-not-found'))});
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  const page=await resumed.newPage();await page.goto(origin+'/factory',{waitUntil:'networkidle'});
  await page.getByText('Validation: running',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-validation')),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-validation-id')),null);
  const prepare=page.getByRole('button',{name:'Prepare another request',exact:true});
  assert(await prepare.isDisabled(),'server-recorded running validation must disable preparing another request without local validation identity');
  assert.equal(await page.getByRole('link',{name:'Download bug case',exact:true}).count(),2);
  assert.equal(await page.getByRole('link',{name:'Download validator package',exact:true}).count(),2);
  validationFinished=true;await page.reload({waitUntil:'networkidle'});
  await page.getByText('Validation: passed',{exact:true}).waitFor();assert.equal(await prepare.isDisabled(),false);
  assert.deepEqual(writes,[]);await resumed.close();
  console.log(`PASS synthetic ${resumedWidth}px: resumed server-side validation without local validation metadata disables new draft until finished; downloads retained and no work started.`);
 }
 for(const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:1000}}); const page=await context.newPage();
  let busyOnce=true,requestId=null,phase='running',interpretation=null,validationId=null,validateCalls=0,refuseValidation=false,missingPackage=null; const starts=[],posts=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/factory/**',async route=>{
   const req=route.request(),url=new URL(req.url()),method=req.method();
   if(method!=='GET')posts.push(url.pathname);
   const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname.endsWith('/capabilities')) {const data=fixture('capabilities');data.service.message='Synthetic fixture service for browser testing — not live execution.';return send(data);}
   if(url.pathname.endsWith('/session'))return send(fixture('session'));
   if(url.pathname.endsWith('/interpretations')) {
    const input=req.postDataJSON();interpretation=fixture('interpretation-supported');interpretation.input=input;
    interpretation.items=interpretation.items.map((item,index)=>({...item,...input.items[index]}));return send(interpretation);
   }
   if(url.pathname==='/api/factory/requests'&&method==='POST') {
    const body=req.postDataJSON();starts.push(body);
    if(busyOnce){busyOnce=false;return send(fixture('error-busy'),409);}
    requestId=body.request_id;
    assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-request-id')),requestId);
    return route.abort('failed'); // Simulate accepted work with a lost start response.
   }
   const status=()=>{const data=fixture(phase==='running'?'status-running':phase==='cancelled'?'status-cancelled':'status-fulfilled');data.request_id=requestId;data.interpretation=interpretation;if(missingPackage!==null)data.cases[0].packages[missingPackage].download_path='';return data;};
   if(url.pathname.endsWith('/stop')){phase='cancelled';return send(status());}
   if(url.pathname.endsWith('/validations')&&method==='POST') {validateCalls++;validationId=req.postDataJSON().validation_id;assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-validation-id')),validationId);if(refuseValidation)return send(fixture('error-busy-needs-reconciliation'),409);return route.abort('failed');}
   if(url.pathname.includes('/validations/')){if(refuseValidation)return send(fixture('error-not-found'),404);const data=fixture('validation-passed');data.validation_id=validationId;return send(data);}
   if(url.pathname.includes('/requests/'))return requestId===null?send(fixture('error-not-found'),404):send(status());
   return send(fixture('error-not-found'),404);
  });
  await page.goto(origin+'/factory',{waitUntil:'networkidle'});
  await page.getByRole('checkbox',{name:/Task and report service/}).check();
  const description=page.getByLabel('Optional description for item 1',{exact:true});
  const reviewRequirements=page.getByRole('button',{name:'Review requirements',exact:true});
  assert.equal(await description.getAttribute('maxlength'),null);
  await description.fill(' \n'+'😀'.repeat(500)+' \n');
  assert.equal(await description.inputValue(),' \n'+'😀'.repeat(500)+' \n');
  assert.equal(await reviewRequirements.isDisabled(),false);
  await description.fill('😀'.repeat(501));
  assert.equal(await description.getAttribute('aria-invalid'),'true');
  assert(await reviewRequirements.isDisabled());
  await description.fill('e\u0301'.repeat(250));
  assert.equal(await reviewRequirements.isDisabled(),false);
  await description.fill('e\u0301'.repeat(250)+'x');
  assert(await reviewRequirements.isDisabled());
  console.log(`PASS synthetic ${width}px: trimmed descriptions accept 500 Unicode code points and reject 501; astral characters and combining marks use the contract's units`);
  await page.getByLabel('Optional description for item 1',{exact:true}).fill('lost update');
  await page.getByLabel('Quantity for item 1',{exact:true}).fill('2');
  await page.getByRole('button',{name:'Add request item',exact:true}).click();
  await page.getByLabel('Bug type for item 2',{exact:true}).selectOption('date_time');
  await page.getByLabel('Optional description for item 2',{exact:true}).fill('daily totals use the wrong time zone');
  await page.getByRole('checkbox',{name:/Umami —/}).uncheck();await page.getByRole('checkbox',{name:/Umami —/}).check();
  assert.equal(await page.getByLabel('Optional description for item 1',{exact:true}).inputValue(),'lost update');
  assert.equal(await page.getByLabel('Quantity for item 1',{exact:true}).inputValue(),'2');
  const budget=page.getByLabel('Shared budget (USD)',{exact:true});await budget.fill('0');assert.equal(await budget.getAttribute('aria-invalid'),'true');await budget.fill('2');
  for(let n=3;n<=5;n++)await page.getByRole('button',{name:'Add request item',exact:true}).click();
  assert(await page.getByRole('button',{name:'Add request item',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Remove item 5',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'factory-quantity-item-1');
  await page.getByRole('button',{name:'Remove item 4',exact:true}).click();await page.getByRole('button',{name:'Remove item 3',exact:true}).click();
  await page.getByLabel('Quantity for item 1',{exact:true}).fill('1');
  await page.getByRole('button',{name:'Review requirements',exact:true}).click();await page.getByRole('heading',{name:'Service interpretation'}).waitFor();
  await page.getByLabel('Optional description for item 2',{exact:true}).fill('events are counted on the wrong day');
  assert.equal(await page.getByRole('heading',{name:'Service interpretation'}).count(),0);
  await page.getByRole('button',{name:'Review requirements',exact:true}).click();
  const start=page.getByRole('button',{name:'Start request',exact:true});await start.waitFor();await start.click();
  await page.getByRole('alert').filter({hasText:'busy:'}).waitFor();
  await page.getByLabel('Optional description for item 1',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.getByLabel('Optional description for item 1',{exact:true}).inputValue(),'lost update');
  assert.equal(await page.getByLabel('Optional description for item 2',{exact:true}).inputValue(),'events are counted on the wrong day');
  assert.equal(await budget.inputValue(),'2');
  await start.evaluate(button=>{button.click();button.click();});
  await page.getByRole('heading',{name:'Request running',exact:true}).waitFor();assert.equal(starts.length,2);
  assert.equal(starts[0].input.items.length,2);assert.equal(starts[0].input.items[0].description,'lost update');
  await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'Request running',exact:true}).waitFor();assert.equal(starts.length,2);
  await page.getByRole('button',{name:'Stop request',exact:true}).click();await page.getByRole('heading',{name:'Cancelled',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Download bug case',exact:true}).count(),1);
  assert.equal(await page.getByRole('link',{name:'Download validator package',exact:true}).count(),1);
  await page.getByRole('button',{name:'Validate case',exact:true}).click();await page.getByText('Validation: passed',{exact:true}).waitFor();assert.equal(validateCalls,1);
  await page.reload({waitUntil:'networkidle'});await page.getByText('Validation: passed',{exact:true}).waitFor();assert.equal(validateCalls,1);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  await page.screenshot({path:join(outputDir, `fixture-${width}.png`),fullPage:true});
  for(const part of ['bug_case','validator']){
   missingPackage=part; // Deliberately malformed response, not a valid contract fixture.
   await page.reload({waitUntil:'networkidle'});
   assert(await page.getByRole('button',{name:'Validate case',exact:true}).isDisabled());
   assert.equal(await page.locator('a[href=""]').count(),0);
   const missingName=part==='bug_case'?'Download bug case':'Download validator package';
   const retainedName=part==='bug_case'?'Download validator package':'Download bug case';
   assert.equal(await page.getByRole('link',{name:missingName,exact:true}).count(),0);
   assert.equal(await page.getByRole('link',{name:retainedName,exact:true}).count(),1);
   assert.equal(validateCalls,1);
  }
  missingPackage=null;await page.reload({waitUntil:'networkidle'});
  assert.equal(await page.getByRole('button',{name:'Validate case',exact:true}).isDisabled(),false);
  console.log(`PASS defensive ${width}px: empty package paths hide only the affected download, block validation and recover after a corrected response`);
  refuseValidation=true;
  await page.getByRole('button',{name:'Validate case',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'busy:'}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-validation')),null);
  assert.equal(await page.evaluate(()=>localStorage.getItem('rbw-factory-validation-id')),null);
  assert.equal(await page.getByRole('button',{name:'Retry the same validation',exact:true}).count(),0);
  assert.equal(await page.getByRole('link',{name:'Download bug case',exact:true}).count(),1);
  await page.reload({waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Prepare another request',exact:true}).click();
  await page.getByLabel('Optional description for item 1',{exact:true}).waitFor({state:'visible'});
  assert.equal(validateCalls,2);assert.deepEqual(errors,[]);
  console.log(`PASS synthetic ${width}px: non-retryable busy validation refusal clears rejected identity, retains cases and permits a new request after reload`);
  console.log(`PASS synthetic ${width}px: capabilities/form/limits/errors, host preservation, removal focus, interpretation invalidation, busy refusal preserves draft, stored-id lost response/reload, duplicate clicks, stop retained case, separate downloads, validation identity recovery; no real service calls`);
  await context.close();
 }
 const tabs=await browser.newContext();let tabStarts=0,savedId=null,tabsFinished=false,tabValidationId=null,tabValidationCalls=0,finishTabValidation;
 const validationGate=new Promise(resolve=>{finishTabValidation=resolve;});
 await tabs.route('**/api/factory/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  let body;
  if(path.endsWith('/capabilities')){body=fixture('capabilities');body.service.message='Synthetic two-tab fixture — not live execution.';}
  else if(path.endsWith('/session'))body=fixture('session');
  else if(path.endsWith('/interpretations')){body=fixture('interpretation-supported');body.input=request.postDataJSON();}
  else if(path.includes('/validations')){if(request.method()==='POST'){tabValidationCalls++;tabValidationId=request.postDataJSON().validation_id;await validationGate;}body=fixture('validation-running');body.validation_id=tabValidationId;}
  else {if(request.method()==='POST'){tabStarts++;savedId=request.postDataJSON().request_id;}body=fixture(tabsFinished?'status-fulfilled':'status-running');body.request_id=savedId;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const first=await tabs.newPage(),second=await tabs.newPage();
 for(const tab of [first,second]){await tab.goto(origin+'/factory',{waitUntil:'networkidle'});await tab.getByRole('button',{name:'Review requirements',exact:true}).click();await tab.getByRole('button',{name:'Start request',exact:true}).waitFor();}
 await first.evaluate(()=>{void navigator.locks.request('rbw-factory-identity',async()=>{globalThis.factoryTestLockHeld=true;await new Promise(resolve=>{globalThis.releaseFactoryTestLock=resolve;});});});
 await first.waitForFunction(()=>globalThis.factoryTestLockHeld===true);
 await Promise.all([first.getByRole('button',{name:'Start request',exact:true}).click(),second.getByRole('button',{name:'Start request',exact:true}).click()]);
 assert.equal(tabStarts,0);await first.evaluate(()=>globalThis.releaseFactoryTestLock());
 await first.getByRole('heading',{name:'Request running',exact:true}).waitFor();await second.getByRole('heading',{name:'Request running',exact:true}).waitFor();
 assert.equal(tabStarts,1);assert.equal(await second.evaluate(()=>localStorage.getItem('rbw-factory-request-id')),savedId);
 await first.reload({waitUntil:'networkidle'});await first.getByRole('heading',{name:'Request running',exact:true}).waitFor();assert.equal(tabStarts,1);
 tabsFinished=true;
 for(const tab of [first,second]){await tab.reload({waitUntil:'networkidle'});await tab.getByRole('heading',{name:'Fulfilled',exact:true}).waitFor();}
 await first.getByRole('button',{name:'Validate case',exact:true}).first().click();
 await first.waitForFunction(()=>localStorage.getItem('rbw-factory-validation-id')!==null);
 await second.getByRole('button',{name:'Prepare another request',exact:true}).click();
 assert.equal(await second.evaluate(()=>localStorage.getItem('rbw-factory-request-id')),savedId);
 finishTabValidation();await second.getByText('Validation: running',{exact:true}).waitFor();
 assert.equal(await second.evaluate(()=>localStorage.getItem('rbw-factory-validation-id')),tabValidationId);
 assert.equal(await second.getByRole('link',{name:'Download bug case',exact:true}).count(),2);
 await second.reload({waitUntil:'networkidle'});await second.getByText('Validation: running',{exact:true}).waitFor();assert.equal(tabValidationCalls,1);
 await tabs.close();console.log('PASS synthetic simultaneous tabs serialize Start; cleanup during another tab’s validation preserves identity, delivered cases and reload.');
 const context=await browser.newContext();const page=await context.newPage();const writes=[];
 page.on('request',request=>{if(request.method()!=='GET')writes.push(request.url());});
 await page.goto(origin+'/factory',{waitUntil:'networkidle'});await page.getByText('Live requests unavailable',{exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'Review requirements',exact:true}).isDisabled());assert.equal(writes.length,0);
 await page.screenshot({path:join(outputDir, "unavailable.png"),fullPage:true});
 for(const path of ['/', '/cases/319f3100-9ecf-441d-b7af-a643af9ae4e5']) {
  await page.goto(origin+path,{waitUntil:'networkidle'});for(const id of ['cell-1','cell-2','cell-3','cell-4','cell-5','cell-6','bug-report','recorded-replays'])assert.equal(await page.locator('#'+id).count(),1);
 }
 const issue=await page.request.get(origin+'/releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/issue.json');assert.equal(issue.status(),200);assert.deepEqual(await issue.body(),fs.readFileSync(join(resultsRepository, "releases/319f3100-9ecf-441d-b7af-a643af9ae4e5/issue.json")));
 console.log('PASS actual unavailable service disables requests; original homepage/release anchors and frozen issue bytes preserved. No replay submitted.');
 await context.close();await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
