const assert=require('assert');
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).pebble;
assert.strictEqual(pkg.projectType,'plugin');
assert.strictEqual(pkg.manifestVersion,2);
assert(pkg.plugin.sources.length>0);
assert(pkg.plugin.sources.every(source=>source.category==='agent'),
  'All sources must use the Pebble Store-supported agent category');
assert(pkg.plugin.sources.some(source=>source.items.includes('entity')));
assert(pkg.plugin.sources.some(source=>source.items.includes('configured')));
assert(pkg.plugin.actions.find(a=>a.name==='call_service').callerPermissions.includes('HomeControl'));
assert(pkg.plugin.actions.find(a=>a.name==='conversation').callerPermissions.includes('HomeConverse'));
assert(pkg.plugin.actions.find(a=>a.name==='get_config').callerPermissions.includes('HomeRead'));
assert(pkg.plugin.actions.find(a=>a.name==='send_to_agent').callerPermissions.includes('HomeConverse'));
assert(pkg.usesPermissions.includes('ShowNotifications'));
for(const name of ['tts_prepare','tts_chunk','tts_release'])
  assert(pkg.plugin.actions.find(a=>a.name===name).callerPermissions.includes('HomeConverse'));

assert(pkg.plugin.sources.find(s=>s.items.includes('entity')).callerPermissions.includes('HomeRead'));
let config,source,action,stored={},local={},calls=[],notifications=[],assistReply=null;
let transientProxyFailures=0;
const secure={
  getItem:async k=>stored[k]||null,
  setItem:async(k,v)=>{stored[k]=v;},
  removeItem:async k=>{delete stored[k];}
};
const Pebble={secureStorage:secure,refreshSources:()=>{},showNotification:n=>notifications.push(n),
  registerConfigHandler:fn=>config=fn,
  registerSourceHandler:fn=>source=fn,
  registerActionHandler:fn=>action=fn};
class MockWebSocket {
  constructor(url) {
    assert(url==='wss://ha.example.com/api/websocket' ||
      url==='ws://192.168.1.2:8123/api/websocket');
    this.send=(raw)=>{
      const message=JSON.parse(raw);
      if(message.type==='auth') {
        assert.strictEqual(message.access_token,'secret');
        this.onmessage({data:JSON.stringify({type:'auth_ok'})});
      } else {
        let result=message.type==='assist_pipeline/pipeline/list'?
          {preferred_pipeline:'pipeline-1',pipelines:[{
            id:'pipeline-1',name:'Default Assist',
            stt_engine:'stt.mock',tts_engine:'tts.mock',
            conversation_engine:'conversation.google_ai'
          }]}:
          {agents:[{id:'conversation.google_ai',name:'Google AI'}]};
        this.onmessage({data:JSON.stringify({id:1,type:'result',success:true,result})});
      }
    };
    this.close=()=>{};
    Promise.resolve().then(()=>this.onmessage({data:JSON.stringify({type:'auth_required'})}));
  }
}
const context={Pebble,console,Date,JSON,Number,String,Object,Array,Promise,isFinite,WebSocket:MockWebSocket,
  // Invoke TTS retry backoffs in a microtask; leave unrelated timers inert.
  setTimeout:(fn,delay)=>{
    if(delay===200||delay===400)Promise.resolve().then(fn);
    return 1;
  },clearTimeout:()=>{},
  localStorage:{getItem:k=>local[k]||null,setItem:(k,v)=>local[k]=v,removeItem:k=>delete local[k]},
  fetch:async(url,opt)=>{
    calls.push({url,opt});
    const path=new URL(url).pathname;
    let data=path==='/api/config'?{location_name:'Test Home'}:
      path==='/api/states'?[{entity_id:'sensor.temp',state:'21.5',attributes:{friendly_name:'Temperature',unit_of_measurement:'°C'}},
        {entity_id:'light.kitchen',state:'on',attributes:{friendly_name:'Kitchen'}}]:
      path==='/api/conversation/process'?assistReply||{conversation_id:'abc',response:{speech:{plain:{speech:'Lights are on.'}}}}:
      path==='/api/tts_get_url'?{path:'/api/tts_proxy/demo.wav'}:
      {entity_id:'light.kitchen',state:'on',attributes:{}};
    if(path==='/api/tts_proxy/demo.wav'){
      if(transientProxyFailures>0){
        transientProxyFailures--;
        return {ok:false,status:500};
      }
      assert.strictEqual(opt.responseType,'arraybuffer',
        'Pebble plugin fetch must request binary responseType before downloading WAV');
      const wav=new Uint8Array(44+32000);
      wav.set(Buffer.from('RIFF', 'ascii'),0);
      wav.set(Buffer.from('WAVEfmt ', 'ascii'),8);
      wav.set(Buffer.from('data', 'ascii'),36);
      const hdr=new DataView(wav.buffer);
      hdr.setUint32(4,0xFFFFFFFF,true); // streaming RIFF size
      hdr.setUint32(16,16,true); // fmt size
      hdr.setUint16(20,1,true); // PCM
      hdr.setUint16(22,1,true); // mono
      hdr.setUint32(24,16000,true);
      for(let i=0;i<16000;i++)hdr.setInt16(44+i*2,Math.round(11000*Math.sin(2*Math.PI*440*i/16000)),true);
      hdr.setUint16(34,16,true);
      hdr.setUint32(40,0x7FFFFFFF,true); // alternate indefinite data size
      return {ok:true,status:200,arrayBuffer:async()=>wav.buffer};
    }
    return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data,text:async()=>JSON.stringify(data)};
  },
  URL
};
vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
function callConfig(m){return new Promise(resolve=>config(m,resolve));}
function callAction(name,args){return new Promise(resolve=>action({action:name,args:args||{}},{
  ok:x=>resolve({ok:true,...x}),error:(code,message)=>resolve({ok:false,code,message})}));}
function callSource(item){return new Promise(resolve=>source({item},{data:d=>resolve(d),error:(code,message)=>resolve({code,message})}));}
(async()=>{
  // Local HTTP is opt-in, restricted to RFC1918 LAN and mDNS .local.
  const validBase=vm.runInNewContext('validBase',context);
  for(const url of ['http://192.168.1.2:8123','http://10.0.0.2:8123',
    'http://172.16.1.1:8123','http://172.31.255.254:8123',
    'http://homeassistant.local:8123']){
    assert.strictEqual(validBase(url,true),url);
    assert.throws(()=>validBase(url,false));
  }
  for(const url of ['http://8.8.8.8:8123','http://example.com:8123',
    'http://172.32.0.1:8123','http://192.167.1.2:8123',
    'http://192.168.1.999:8123','http://127.0.0.1:8123',
    'http://localhost:8123','http://192.168.001.2:8123',
    'http://192.168.1.2:0','http://192.168.1.2:65536',
    'http://192.168.1.2:8123/path','http://user@192.168.1.2:8123',
    'http://homeassistant.local.evil.com:8123']){
    assert.throws(()=>validBase(url,true),'Reject non-LAN or unsafe URL '+url);
  }
  let insecure=await callConfig({type:'save',url:'http://192.168.1.2:8123',
    token:'secret',allow_local_http:false});
  assert.strictEqual(insecure.ok,false,'HTTP must remain opt-in');
  assert(!local.ha_bridge_url,'Rejected URL must not be persisted');
  let s=await callConfig({type:'save',url:'https://ha.example.com',token:'secret'});
  assert.strictEqual(s.ok,true);
  assert.strictEqual(stored.ha_bridge_token,'secret');
  const initialStatus=await callConfig({type:'status'});
  assert.strictEqual(initialStatus.allow_local_http,false);
  let localSaved=await callConfig({type:'save',url:'http://192.168.1.2:8123',
    token:'',allow_local_http:true});
  assert(localSaved.ok,'Opt-in LAN HTTP saves using existing secure token');
  assert.strictEqual((await callConfig({type:'status'})).allow_local_http,true);
  assert.strictEqual(local.ha_bridge_url,'http://192.168.1.2:8123');
  const discoverLocal=await callConfig({type:'voice_discover'});
  assert(discoverLocal.ok,'Local HTTP uses ws:// instead of wss:// for discovery');
  const unsafeSave=await callConfig({type:'save',url:'http://8.8.8.8:8123',
    token:'',allow_local_http:true});
  assert(!unsafeSave.ok);
  assert.strictEqual(local.ha_bridge_url,'http://192.168.1.2:8123');
  // Restore HTTPS before running normal API tests.
  assert((await callConfig({type:'save',url:'https://ha.example.com',
    token:'',allow_local_http:false})).ok);
  assert.strictEqual((await callConfig({type:'status'})).allow_local_http,false);

  assert(!JSON.stringify(await callConfig({type:'status'})).includes('secret'));
  s=await callConfig({type:'test'});assert.strictEqual(s.name,'Test Home');
  let data=await callSource('entity');
  assert.strictEqual(data.instances.length,2);
  assert.strictEqual(data.instances[0].properties.value.numericValue.value,21.5);
  let discovery=await callConfig({type:'voice_discover'});
  assert(discovery.ok);
  assert(discovery.discovery.agents.some(a=>a.id==='conversation.google_ai'));
  assert(discovery.discovery.stt.some(e=>e.id==='stt.mock'));
  assert(discovery.discovery.tts.some(e=>e.id==='tts.mock'));
  assert(discovery.discovery.pipelines.some(p=>p.id==='pipeline-1'));
  assert.strictEqual(discovery.discovery.preferred_pipeline,'pipeline-1');
  let defaults=await callConfig({type:'voice_save',values:{
    stt_engine:'stt.test',tts_engine:'tts.test',agent_id:'conversation.google_ai',
    pipeline_id:'preferred-id'}});
  assert(defaults.ok);
  assert.strictEqual(defaults.defaults.agent_id,'conversation.google_ai');
  assert(!JSON.stringify(defaults).includes('secret'));
  let cfg=await callAction('get_config');
  assert(cfg.ok);
  assert.strictEqual(JSON.parse(cfg.text).pipeline_id,'preferred-id');
  assert(!cfg.text.includes('secret'));
  let r=await callAction('conversation',{text:'Hello'});
  assert(r.ok);assert(JSON.parse(r.text).text==='Lights are on.');
  const lastConversation=calls.filter(c=>c.url.endsWith('/api/conversation/process')).pop();
  assert.strictEqual(JSON.parse(lastConversation.opt.body).agent_id,'conversation.google_ai');
  // Index 01 destination: plain speech text, default agent, no watch reply unless opted in.
  r=await callAction('send_to_agent',{message:'Turn on the lights',chat_id:'c1'});
  assert(r.ok);assert.strictEqual(r.text,'Lights are on.');
  const indexBody=JSON.parse(calls.filter(c=>c.url.endsWith('/api/conversation/process')).pop().opt.body);
  assert.strictEqual(indexBody.text,'Turn on the lights');
  assert.strictEqual(indexBody.agent_id,'conversation.google_ai');
  assert.strictEqual(notifications.length,0,'Watch replies are off by default');
  r=await callAction('send_to_agent',{message:'  '});
  assert.strictEqual(r.code,'INVALID_ARGS');
  s=await callConfig({type:'status'});assert.strictEqual(s.watch_replies,false);
  s=await callConfig({type:'index_save',watch_replies:true});assert.strictEqual(s.watch_replies,true);
  s=await callConfig({type:'status'});assert.strictEqual(s.watch_replies,true);
  r=await callAction('send_to_agent',{message:'Turn on the lights'});
  assert(r.ok);
  assert.strictEqual(notifications.length,1);
  assert.strictEqual(notifications[0].layout.body,'Lights are on.');
  // Assist answers "no such device" with HTTP 200 and response_type error.
  assistReply={response:{response_type:'error',speech:{plain:{speech:'No device called toaster'}}}};
  r=await callAction('send_to_agent',{message:'Turn on the toaster'});
  assistReply=null;
  assert.strictEqual(r.code,'ASSIST_ERROR');assert.strictEqual(r.message,'No device called toaster');
  assert.strictEqual(notifications[1].layout.body,'No device called toaster');
  s=await callConfig({type:'index_save',watch_replies:'yes'});assert.strictEqual(s.watch_replies,false,'Only boolean true enables replies');
  // A 16kHz HA WAV must be normalized to the precise 8kHz PCM16 WAV
  // that Gemini's phone-side lowPassFilter/encodeADPCM pipeline expects.
  // Bridge-origin tone uses the same persisted WAV session and chunk transport.
  // Unlike a phone-generated tone, it exercises every plugin byte boundary.
  let reference=await callAction('tts_prepare',{test_tone:true});
  assert(reference.ok,'Bridge diagnostic must not require a TTS provider');
  let refMeta=JSON.parse(reference.text);
  assert.strictEqual(refMeta.length,112044);
  assert.strictEqual(refMeta.sample_rate,8000);
  assert.strictEqual(Buffer.from(refMeta.first_chunk,'base64').length,6000);
  let firstHash=2166136261>>>0;
  for(const byte of Buffer.from(refMeta.first_chunk,'base64'))
    firstHash=Math.imul((firstHash^byte)>>>0,16777619)>>>0;
  assert.strictEqual(refMeta.first_chunk_checksum,firstHash,
    'The first streaming chunk must be authenticated before playback');
  assert.strictEqual(refMeta.audio_diagnostics.source,'bridge_test_tone');
  let refParts=[];
  for(let off=0;off<refMeta.length;off+=refMeta.chunk_bytes){
    vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
    const part=await callAction('tts_chunk',{session_id:refMeta.session_id,offset:off});
    assert(part.ok,'Bridge tone chunk '+off);
    const chunk=JSON.parse(part.text);
    const chunkBytes=Buffer.from(chunk.audio,'base64');
    let chunkHash=2166136261>>>0;
    for(const byte of chunkBytes)
      chunkHash=Math.imul((chunkHash^byte)>>>0,16777619)>>>0;
    assert.strictEqual(chunk.checksum,chunkHash,
      'Every streaming chunk must carry an independent checksum');
    refParts.push(chunkBytes);
  }
  const refWave=Buffer.concat(refParts);
  let refHash=2166136261>>>0;
  for(const b of refWave)refHash=Math.imul((refHash^b)>>>0,16777619)>>>0;
  assert.strictEqual(refHash,refMeta.wav_checksum);
  assert.strictEqual(refWave.readUInt32LE(24),8000);
  await callAction('tts_release',{session_id:refMeta.session_id});
  const speech=await callAction('tts_prepare',{text:'Lights are on.'});
  assert(speech.ok,'Plugin should deliver a valid WAV without exporting credentials');
  const meta=JSON.parse(speech.text);
  assert.strictEqual(meta.format,'pcm_s16le_wav');
  assert.strictEqual(meta.sample_rate,8000);
  assert.strictEqual(meta.channels,1);
  assert.strictEqual(meta.bits_per_sample,16);
  assert.strictEqual(meta.sample_count,8000);
  assert.strictEqual(meta.length,16044);
  assert.strictEqual(typeof meta.first_chunk,'string');
  assert.strictEqual(Buffer.from(meta.first_chunk,'base64').length,6000,
    'Prepare must inline its first already persisted audio chunk');
  assert.strictEqual(meta.audio_diagnostics.input_rate,16000);
  assert(meta.audio_diagnostics.byte_order);
  assert(meta.audio_diagnostics.byte_order.examined_samples>0);
  assert(meta.audio_diagnostics.byte_order.little_endian.rms>0);
  assert(meta.audio_diagnostics.byte_order.big_endian.rms>0);
  assert.strictEqual(meta.audio_diagnostics.source,'home_assistant');
  assert(meta.audio_diagnostics.stage_ms,'Per-stage bridge timing missing');
  for(const name of ['ha_generation','binary_download','wav_parse','resample','session_storage','total_bridge']){
    assert(Number.isFinite(meta.audio_diagnostics.stage_ms[name]),'Invalid stage timing '+name);
    assert(meta.audio_diagnostics.stage_ms[name]>=0,'Negative stage time '+name);
  }
  assert.strictEqual(meta.audio_diagnostics.binary_transport,'fetch_arraybuffer');
  // Pebble starts a fresh plugin JS context for every action.
  vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  let audio=[];
  for(let offset=0;offset<meta.length;offset+=meta.chunk_bytes){
    const reply=await callAction('tts_chunk',{session_id:meta.session_id,offset});
    assert(reply.ok,'Chunk '+offset+' should be readable');
    const payload=JSON.parse(reply.text);
    assert.strictEqual(payload.offset,offset);
    const chunkBytes=Buffer.from(payload.audio,'base64');
    let chunkHash=2166136261>>>0;
    for(const byte of chunkBytes)
      chunkHash=Math.imul((chunkHash^byte)>>>0,16777619)>>>0;
    assert.strictEqual(payload.checksum,chunkHash);
    audio.push(chunkBytes);
    vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  }
  const wav=Buffer.concat(audio);
  assert.strictEqual(wav.length,meta.length);
  let check=2166136261>>>0;
  for(const byte of wav)check=Math.imul((check^byte)>>>0,16777619)>>>0;
  assert.strictEqual(meta.wav_checksum,check,'WAV checksum must cover every transmitted byte');
  assert.strictEqual(wav.toString('ascii',0,4),'RIFF');
  assert.strictEqual(wav.toString('ascii',8,12),'WAVE');
  assert.strictEqual(wav.toString('ascii',12,16),'fmt ');
  assert.strictEqual(wav.toString('ascii',36,40),'data');
  assert.strictEqual(wav.readUInt32LE(4),wav.length-8);
  assert.strictEqual(wav.readUInt32LE(40),16000);
  assert.strictEqual(wav.readUInt16LE(20),1);
  assert.strictEqual(wav.readUInt16LE(22),1);
  assert.strictEqual(wav.readUInt32LE(24),8000);
  assert.strictEqual(wav.readUInt16LE(34),16);
  let error=0;
  for(let i=0;i<8000;i++)
    error+=Math.abs(wav.readInt16LE(44+i*2)-
      Math.round(11000*Math.sin(2*Math.PI*440*i/8000)));
  assert(error/8000<600,'Resampling should preserve the speech-band tone');
  // Reject non-PCM instead of passing compressed bytes as PCM samples.
  const unsupported=new Uint8Array(wav);
  new DataView(unsupported.buffer).setUint16(20,3,true);
  const parse=vm.runInNewContext('wavPcm16',context);
  assert.strictEqual(parse(unsupported).ok,false);
  // The captured broken HTTP response had 0xFDFDFDFD where streaming WAV
  // uses an indefinite data size, and 0x3EFD where 16kHz is 0x3E80.
  // Detect this as binary corruption, not a new valid streaming marker.
  const isMangled=vm.runInNewContext('looksLikeMangledBinary',context);
  const damaged=Buffer.from(wav);
  damaged.writeUInt32LE(0xFDFDFDFD,40);
  assert.strictEqual(isMangled(new Uint8Array(damaged)),true);
  assert.strictEqual(isMangled(new Uint8Array(wav)),false);
  // Access to XMLHttpRequest is explicitly blocked in plugin contexts.
  // No plugin code should even evaluate typeof XMLHttpRequest.
  Object.defineProperty(context,'XMLHttpRequest',{
    configurable:true,
    get(){throw Error('XMLHttpRequest is not available to plugins');}
  });
  vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
  const stillWorks=await callAction('tts_prepare',{text:'Testing safe plugin fetch'});
  assert(stillWorks.ok,'Plugin fetch must work even with throwing XHR global');
  await callAction('tts_release',{session_id:JSON.parse(stillWorks.text).session_id});
  // Home Assistant intermittently returns HTTP 500 for a generated
  // tts_proxy file when a longer answer prepares its next sentence.
  // Bridge must request a FRESH, uncached proxy URL rather than fail.
  transientProxyFailures=1;
  const retryBegin=calls.length;
  const recovered=await callAction('tts_prepare',{text:'Retry proxy playback sentence.'});
  assert(recovered.ok,'One transient TTS proxy 500 must recover without lost audio');
  const retryCalls=calls.slice(retryBegin);
  const retries=retryCalls.filter(c=>c.url.endsWith('/api/tts_get_url'));
  assert.strictEqual(retries.length,2,'Must regenerate TTS URL after HTTP 500');
  assert.strictEqual(JSON.parse(retries[1].opt.body).cache,false,
    'Recovered request must disable cached TTS URL');
  await callAction('tts_release',{session_id:JSON.parse(recovered.text).session_id});
  // Persistent server errors still fail after a finite number of requests.
  transientProxyFailures=4;
  const terminalBegin=calls.length;
  const notRecovered=await callAction('tts_prepare',{text:'Persistent TTS proxy failure.'});
  assert.strictEqual(notRecovered.ok,false);
  assert(String(notRecovered.message).includes('HTTP 500'));
  assert.strictEqual(calls.slice(terminalBegin).filter(
    c=>c.url.endsWith('/api/tts_get_url')).length,3,
    'Persistent TTS failures must stop after exactly three attempts');
  transientProxyFailures=0;
  // WAV may have metadata after its finite data chunk. Do not interpret
  // those trailing chunks as speech; doing so creates audible noise.
  const withTrailer=Buffer.alloc(wav.length+20);
  wav.copy(withTrailer,0);
  withTrailer.write('LIST',wav.length,'ascii');
  withTrailer.writeUInt32LE(12,wav.length+4);
  withTrailer.fill(0x7f,wav.length+8);
  // A nonstandard 0xFDFDFDFD length is an unknown-size streamed WAV,
  // not 4.26 GB of audio; trust only the complete received samples.
  const streamedFixture=Buffer.from(wav);
  streamedFixture.writeUInt32LE(0xFDFDFDFD,40);
  const streamedParsed=parse(new Uint8Array(streamedFixture));
  assert(streamedParsed.ok);
  assert.strictEqual(streamedParsed.samples.length,8000);
  assert.strictEqual(streamedParsed.streamed_data,true);
  const trailingParsed=parse(new Uint8Array(withTrailer));
  assert(trailingParsed.ok);
  assert.strictEqual(trailingParsed.samples.length,8000);
  assert.strictEqual(trailingParsed.available_data_bytes,16020);
  assert.strictEqual(trailingParsed.used_data_bytes,16000);
  // Diagnostic source rate must be forwarded but output format stays Gemini.
  const sourceTest=await callAction('tts_prepare',{
    text:'Diagnostic phrase',source_rate:16000,diagnostic:true
  });
  assert(sourceTest.ok,'Uncached high-rate TTS source should work');
  const sourceMeta=JSON.parse(sourceTest.text);
  assert.strictEqual(sourceMeta.sample_rate,8000);
  assert.strictEqual(sourceMeta.audio_diagnostics.requested_rate,16000);
  const latestPost=calls.filter(c=>c.url.endsWith('/api/tts_get_url')).pop();
  const latestBody=JSON.parse(latestPost.opt.body);
  assert.strictEqual(latestBody.cache,false);
  assert.strictEqual(latestBody.options.preferred_sample_rate,16000);
  await callAction('tts_release',{session_id:sourceMeta.session_id});
  const end=await callAction('tts_release',{session_id:meta.session_id});
  assert(end.ok);
  const gone=await callAction('tts_chunk',{session_id:meta.session_id,offset:0});
  assert.strictEqual(gone.ok,false,'Released audio sessions must be unavailable');
  const ttsPost=calls.find(c=>c.url.endsWith('/api/tts_get_url'));
  assert.strictEqual(JSON.parse(ttsPost.opt.body).engine_id,'tts.test');
  assert(!speech.text.includes('secret'),'Audio action must not return credentials');
  await callConfig({type:'voice_save',values:{agent_id:''}});
  r=await callAction('call_service',{domain:'light',service:'turn_on',data:{entity_id:'light.kitchen'}});
  assert(r.ok);
  r=await callAction('read_api',{path:'/api/auth'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  r=await callAction('call_service',{domain:'../auth',service:'x'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  assert(calls.every(c=>c.opt.headers.Authorization==='Bearer secret'));
  assert(calls.some(c=>c.url.endsWith('/api/')&&!c.opt.headers['Content-Type']),
    'GET connection test must not send Content-Type');
  assert(calls.every(c=>c.opt.body || !c.opt.headers['Content-Type']),
    'Only requests with JSON bodies should declare Content-Type');
  s=await callConfig({type:'forget'});assert(s.ok);
  assert(!stored.ha_bridge_token);
  assert(!local.ha_voice_defaults_v1,'Forget also clears voice and AI preferences');
  assert(!local.ha_bridge_http_local_opt_in,'Forget clears the HTTP opt-in');
  assert(!local.ha_index_watch_replies_v1,'Forget clears the watch reply option');
  console.log('Home Assistant plugin API and credential isolation checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
