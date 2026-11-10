// Home Assistant Bridge for Pebble plugins (preview API).
// Credentials never leave secureStorage and never appear in source/action results.
var URL_KEY='ha_bridge_url';
var TOKEN_KEY='ha_bridge_token';
var HTTP_LOCAL_KEY='ha_bridge_http_local_opt_in';
var SOURCES=['agent/entity','agent/configured'];
function localHttpEnabled(){return localStorage.getItem(HTTP_LOCAL_KEY)==='true';}
function privateLocalHost(host){
  // Only exact RFC1918 IPv4 or mDNS .local hostnames. Never allow public
  // addresses or domain names that merely contain a private-IP substring.
  if(/^[0-9.]+$/.test(host)){
    var parts=host.split('.');
    if(parts.length!==4)return false;
    for(var i=0;i<parts.length;i++){
      if(!/^(0|[1-9][0-9]{0,2})$/.test(parts[i]))return false;
      if(Number(parts[i])>255)return false;
    }
    var a=Number(parts[0]),b=Number(parts[1]);
    return a===10||(a===172&&b>=16&&b<=31)||
      (a===192&&b===168);
  }
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local$/i.test(host)&&
    host.split('.').every(function(p){return p&&p[0]!=='-'&&p[p.length-1]!=='-';});
}
function validBase(value,allowLocalHttp){
  var s=String(value||'').trim().replace(/\/+$/,'');
  var match=/^(https?):\/\/([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(s);
  if(!match)throw Error('Enter a server URL with no path, credentials, query, or fragment.');
  var scheme=match[1],host=match[2],port=match[3];
  if(port && (Number(port)<1||Number(port)>65535))
    throw Error('Invalid Home Assistant port.');
  if(scheme==='http'){
    if(!allowLocalHttp)
      throw Error('HTTP requires enabling Unsecured Local HTTP mode first.');
    if(!privateLocalHost(host))
      throw Error('Unsecured HTTP is only allowed for private LAN IPv4 addresses or .local hostnames.');
  }
  return s;
}
function baseUrl(){
  var value=localStorage.getItem(URL_KEY)||'';
  if(!value)return '';
  try{return validBase(value,localHttpEnabled());}catch(e){return '';}
}
function safeId(value) {return /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(String(value||''));}
function safePart(value) {return /^[a-z][a-z0-9_]*$/.test(String(value||''));}
function failure(code,message){return {ok:false,code:code,message:message};}
async function api(path,method,body) {
  var url=baseUrl(),token=await Pebble.secureStorage.getItem(TOKEN_KEY);
  if(!url||!token)return failure('AUTH_REQUIRED','Configure the Home Assistant plugin.');
  try {
    var headers={'Authorization':'Bearer '+token,'Accept':'application/json'};
    // A GET request has no JSON body; do not advertise a Content-Type.
    // HA and reverse proxies can apply stricter request validation to GETs.
    if(typeof body!=='undefined')headers['Content-Type']='application/json';
    var res=await fetch(url+path,{
      method:method||'GET',headers:headers,
      body:typeof body==='undefined'?undefined:JSON.stringify(body)
    });
    if(!res.ok){
      var hint='';
      if(res.status===400){
        // Read the response for recognizable HA/proxy errors. Never display
        // arbitrary HTML, authentication data, or sensitive server details.
        try {
          var raw=String(await res.text()).toLowerCase();
          if(raw.indexOf('reverse proxy')!==-1 || raw.indexOf('forwarded')!==-1)
            hint=' (reverse proxy configuration rejected the request)';
          else if(raw.indexOf('invalid host')!==-1)
            hint=' (server rejected the host name)';
          else if(raw.indexOf('bad request')!==-1)
            hint=' (bad request; check Home Assistant logs)';
        }catch(e){}
      }
      return failure(res.status===401||res.status===403?'AUTH_REQUIRED':'PLUGIN_UNAVAILABLE',
        'Home Assistant HTTP '+res.status+hint);
    }
    var contentType=res.headers&&res.headers.get&&res.headers.get('content-type')||'';
    var data=contentType.indexOf('json')>=0?await res.json():await res.text();
    return {ok:true,data:data};
  }catch(e){
    // Never log the URL or token: they may contain private hostnames.
    return failure('PLUGIN_UNAVAILABLE','Home Assistant connection failed; check network permissions and your server URL.');
  }
}
// Shared, token-free voice/AI preferences. Changing these does not modify
// the user's Home Assistant server or its preferred Assist pipeline.
var DEFAULTS_KEY='ha_voice_defaults_v1';
// Plugin-local Index 01 option; deliberately not part of the shared get_config defaults.
var WATCH_REPLIES_KEY='ha_index_watch_replies_v1';
function watchRepliesEnabled(){return localStorage.getItem(WATCH_REPLIES_KEY)==='true';}
function voiceDefaults() {
  var saved={};
  try{saved=JSON.parse(localStorage.getItem(DEFAULTS_KEY)||'{}')||{};}catch(e){}
  return {stt_engine:String(saved.stt_engine||''),
    tts_engine:String(saved.tts_engine||''),
    agent_id:String(saved.agent_id||''),
    pipeline_id:String(saved.pipeline_id||'')};
}
function saveVoiceDefaults(values) {
  var next=voiceDefaults();
  ['stt_engine','tts_engine','agent_id','pipeline_id'].forEach(function(key){
    if(Object.prototype.hasOwnProperty.call(values,key)) {
      var val=values[key];
      if(typeof val!=='string'||val.length>180)throw Error('Invalid '+key);
      next[key]=val;
    }
  });
  localStorage.setItem(DEFAULTS_KEY,JSON.stringify(next));
  return next;
}
// Request-scoped HA WebSocket discovery. Always close it after listing, never
// keep a persistent connection running in the plugin.
function wsList(type) {
  return new Promise(async function(resolve) {
    var socket=null,done=false,timer=null;
    function finish(value) {
      if(done)return;
      done=true;
      if(timer)clearTimeout(timer);
      if(socket){socket.onmessage=null;socket.onerror=null;socket.onclose=null;try{socket.close();}catch(e){}}
      resolve(value);
    }
    try{
      var url=baseUrl(),token=await Pebble.secureStorage.getItem(TOKEN_KEY);
      if(!url||!token||typeof WebSocket!=='function'){finish({ok:false,error:'WebSocket discovery unavailable'});return;}
      socket=new WebSocket(url.replace(/^https:/,'wss:').replace(/^http:/,'ws:')+'/api/websocket');
      timer=setTimeout(function(){finish({ok:false,error:'Discovery timed out'});},7000);
      socket.onmessage=function(event) {
        var msg;try{msg=JSON.parse(event.data);}catch(e){return;}
        if(msg.type==='auth_required')socket.send(JSON.stringify({type:'auth',access_token:token}));
        else if(msg.type==='auth_invalid')finish({ok:false,error:'Home Assistant rejected credentials'});
        else if(msg.type==='auth_ok')socket.send(JSON.stringify({id:1,type:type}));
        else if(msg.type==='result'&&msg.id===1)
          finish(msg.success?{ok:true,data:msg.result}:{ok:false,error:'HA discovery rejected'});
      };
      socket.onerror=function(){finish({ok:false,error:'WebSocket unavailable'});};
      socket.onclose=function(){finish({ok:false,error:'WebSocket disconnected'});};
    }catch(e){finish({ok:false,error:'WebSocket discovery failed'});}
  });
}
function uniqueOptions(options) {
  var seen={};return options.filter(function(o){
    if(!o.id||seen[o.id])return false;
    seen[o.id]=true;return true;
  }).sort(function(a,b){return a.name.localeCompare(b.name);});
}
async function discoverVoice() {
  var states=await api('/api/states');
  var results=await Promise.all([
    wsList('assist_pipeline/pipeline/list'),
    wsList('conversation/agent/list')
  ]);
  var pipelineResult=results[0],agentResult=results[1];
  var pipelines=pipelineResult.ok&&pipelineResult.data&&Array.isArray(pipelineResult.data.pipelines)
    ?pipelineResult.data.pipelines:[];
  var entities=states.ok&&Array.isArray(states.data)?states.data:[];
  var agents=[],tts=[],stt=[];
  entities.forEach(function(e){
    if(!e||typeof e.entity_id!=='string')return;
    var label=String(e.attributes&&e.attributes.friendly_name||e.entity_id);
    if(e.entity_id.indexOf('conversation.')===0)agents.push({id:e.entity_id,name:label});
    if(e.entity_id.indexOf('tts.')===0)tts.push({id:e.entity_id,name:label});
  });
  var list=agentResult.ok?(Array.isArray(agentResult.data)?agentResult.data:
    agentResult.data&&agentResult.data.agents||[]):[];
  list.forEach(function(a){
    if(a&&a.id)agents.push({id:String(a.id),name:String(a.name||a.id)});
  });
  pipelines.forEach(function(p){
    if(p.stt_engine)stt.push({id:String(p.stt_engine),name:String(p.stt_engine)});
    if(p.tts_engine)tts.push({id:String(p.tts_engine),name:String(p.tts_engine)});
    if(p.conversation_engine)agents.push({id:String(p.conversation_engine),name:String(p.conversation_engine)});
  });
  return {
    defaults:voiceDefaults(),
    agents:uniqueOptions(agents),tts:uniqueOptions(tts),stt:uniqueOptions(stt),
    pipelines:pipelines.map(function(p){return {
      id:String(p.id),name:String(p.name||p.id),
      stt_engine:p.stt_engine||'',tts_engine:p.tts_engine||'',
      conversation_engine:p.conversation_engine||''
    };}),
    preferred_pipeline:pipelineResult.ok&&pipelineResult.data?pipelineResult.data.preferred_pipeline||'':'',
    warnings:[!states.ok?'Entity discovery unavailable':null,
      !pipelineResult.ok?'Assist pipeline discovery unavailable':null,
      !agentResult.ok?'Conversation agent discovery unavailable':null].filter(Boolean)
  };
}
function compact(state){
  var a=state.attributes||{};
  return {entity_id:state.entity_id,state:state.state,
    friendly_name:String(a.friendly_name||state.entity_id),
    unit:String(a.unit_of_measurement||''),
    attributes:a,last_changed:state.last_changed};
}
function sourceProperties(state) {
  var a=state.attributes||{},text=String(state.state||'unknown');
  var prop={name:{shortText:{text:String(a.friendly_name||state.entity_id).slice(0,120)}},
    entity_id:{shortText:{text:state.entity_id}},
    domain:{shortText:{text:state.entity_id.split('.')[0]}},
    state:{shortText:{text:text.slice(0,90)},longText:{text:text.slice(0,500)}}};
  var n=Number(text);
  if(text.trim()&&isFinite(n)) {
    prop.value={numericValue:{value:n,unit:String(a.unit_of_measurement||'').slice(0,24)}};
  }
  if(text==='on'||text==='off')prop.on={boolean:{value:text==='on'}};
  if(a.unit_of_measurement)prop.unit={shortText:{text:String(a.unit_of_measurement).slice(0,32)}};
  return prop;
}
Pebble.registerSourceHandler(async function(request,respond){
  if(request.item==='configured'){
    var present=!!baseUrl()&&!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
    respond.data({validUntilMs:Date.now()+120000,instances:[{
      instanceId:'home',properties:{name:{shortText:{text:'Home Assistant'}},
        configured:{boolean:{value:present}}}}]});return;
  }
  if(request.item!=='entity'){respond.error('INVALID_REQUEST','Unknown source');return;}
  var result=await api('/api/states');
  if(!result.ok){respond.error(result.code,result.message);return;}
  if(!Array.isArray(result.data)){respond.error('UNKNOWN','Unexpected states response');return;}
  respond.data({validUntilMs:Date.now()+30000,instances:result.data.slice(0,400).map(function(state){
    return {instanceId:state.entity_id,properties:sourceProperties(state)};
  })});
});
// Pebble restarts the plugin script for EVERY action. TTS chunks therefore
// live briefly in plugin-owned localStorage, never in JS module variables.
// These are transient speech bytes (not credentials); release/TTL removes them.
var MAX_TTS_BYTES=1500000,TTS_CHUNK_BYTES=6000;
var TTS_INDEX_KEY='ha_tts_sessions_v2',TTS_TTL_MS=180000;
function base64Bytes(bytes) {
  var abc='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out='';
  for(var i=0;i<bytes.length;i+=3){
    var a=bytes[i],b=i+1<bytes.length?bytes[i+1]:0,c=i+2<bytes.length?bytes[i+2]:0;
    out+=abc[a>>2]+abc[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?abc[((b&15)<<2)|(c>>6)]:'=')+
      (i+2<bytes.length?abc[c&63]:'=');
  }
  return out;
}
function sessionKey(id){return 'ha_tts_v2_'+id;}
function sessionList(){
  try{var value=JSON.parse(localStorage.getItem(TTS_INDEX_KEY)||'[]');
    return Array.isArray(value)?value:[];}catch(e){return [];}
}
function deleteTtsSession(id){
  var key=sessionKey(id),raw=localStorage.getItem(key),count=0;
  try{count=JSON.parse(raw||'{}').count||0;}catch(e){}
  // Reject tampered metadata that would otherwise trigger unbounded deletion.
  count=Math.min(251,Math.max(0,count));
  for(var i=0;i<count;i++)localStorage.removeItem(key+'_'+i);
  localStorage.removeItem(key);
}
function cleanTtsSessions(){
  var now=Date.now(),keep=[];
  sessionList().forEach(function(id){
    if(!/^tts[a-z0-9]+$/.test(id))return;
    var meta=null;
    try{meta=JSON.parse(localStorage.getItem(sessionKey(id))||'null');}catch(e){}
    if(!meta||meta.expires<now){deleteTtsSession(id);return;}
    keep.push(id);
  });
  localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(keep));
  return keep;
}
function storeTtsSession(bytes){
  var keep=cleanTtsSessions();
  // Keep up to three concurrent speech sessions: the active sentence, one
  // prepared-ahead sentence, and a spare for overlapping release actions.
  // An older active transfer must never be deleted by the next prepare.
  while(keep.length>=3){
    deleteTtsSession(keep.shift());
  }
  localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(keep));
  var id='tts'+Date.now().toString(36)+Math.floor(Math.random()*0x100000000).toString(36);
  var key=sessionKey(id),count=Math.ceil(bytes.length/TTS_CHUNK_BYTES);
  var hashes=[];
  for(var n=0;n<count;n++){
    var pos=n*TTS_CHUNK_BYTES;
    hashes.push(wavChecksum(bytes.subarray(pos,Math.min(bytes.length,pos+TTS_CHUNK_BYTES))));
  }
  var meta={length:bytes.length,count:count,hashes:hashes,expires:Date.now()+TTS_TTL_MS};
  try{
    localStorage.setItem(key,JSON.stringify(meta));
    for(var i=0;i<count;i++){
      var start=i*TTS_CHUNK_BYTES;
      localStorage.setItem(key+'_'+i,base64Bytes(bytes.subarray(start,start+TTS_CHUNK_BYTES)));
    }
    localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(keep.concat([id])));
    return {session_id:id,length:bytes.length,chunk_bytes:TTS_CHUNK_BYTES};
  }catch(e){
    deleteTtsSession(id);
    return null;
  }
}
// Decode a complete mono PCM16 WAV. HA may ignore the preferred sample rate;
// inspect the returned header rather than treating bytes as a different codec.
function wavPcm16(bytes) {
  if(bytes.length<44)return {ok:false,error:'WAV too short'};
  var view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  function tag(p){return String.fromCharCode(bytes[p],bytes[p+1],bytes[p+2],bytes[p+3]);}
  if(tag(0)!=='RIFF'||tag(8)!=='WAVE')return {ok:false,error:'TTS did not return RIFF WAV'};
  var pos=12,fmt=null,start=-1,dataLength=0,declaredSize=0;
  while(pos+8<=bytes.length) {
    var size=view.getUint32(pos+4,true),data=pos+8,name=tag(pos);
    if(name==='fmt ') {
      if(size<16||data+size>bytes.length)return {ok:false,error:'Invalid WAV format'};
      fmt={encoding:view.getUint16(data,true),channels:view.getUint16(data+2,true),
        rate:view.getUint32(data+4,true),bits:view.getUint16(data+14,true)};
    }
    if(name==='data'){start=data;declaredSize=size;break;}
    if(size>bytes.length-data)return {ok:false,error:'Truncated WAV '+name};
    pos=data+size+(size&1);
  }
  if(!fmt||start<0)return {ok:false,error:'Missing WAV audio format or data'};
  if(fmt.encoding!==1||fmt.channels!==1||fmt.bits!==16||
     fmt.rate<8000||fmt.rate>48000)
    return {ok:false,error:'TTS requires mono PCM16 WAV (8-48 kHz)'};
  // Respect a valid finite 'data' chunk length; a WAV can contain trailing
  // LIST, INFO or metadata chunks. Do not decode those non-audio bytes as PCM.
  // Home Assistant streamed WAV may use unknown (0xFFFFFFFF/0x7FFFFFFF)
  // or overstated sizes, so in those cases use available complete frames.
  var available=bytes.length-start;
  var streamed=declaredSize===0||declaredSize===0xFFFFFFFF||declaredSize===0x7FFFFFFF||declaredSize===0xFDFDFDFD;
  var usable=(streamed||declaredSize>available)?
    available:Math.min(available,declaredSize);
  usable-=usable%2;
  var length=usable/2;
  if(!length)return {ok:false,error:'Empty WAV audio'};
  var samples=new Int16Array(length);
  for(var i=0;i<length;i++)samples[i]=view.getInt16(start+i*2,true);
  return {ok:true,samples:samples,rate:fmt.rate,
    byte_order_analysis:inspectPcmByteOrder(bytes,start,length),
    declared_data_bytes:declaredSize,available_data_bytes:available,
    used_data_bytes:usable,streamed_data:streamed};
}
// Convert source PCM16 to the native Gemini-compatible 8 kHz playback rate.
// If HA supplies 16 kHz, use a 31-tap windowed-sinc low-pass FIR *before*
// dropping every other sample to avoid audible aliasing. Other supported
// sample rates are converted with a band-limited interpolation kernel.
function resample8k(samples,rate) {
  if(rate===8000)return samples;
  var outLength=Math.max(1,Math.round(samples.length*8000/rate));
  var out=new Int16Array(outLength);
  var cutoff=Math.min(0.45,3600/rate);
  var radius=16;
  for(var i=0;i<outLength;i++) {
    var center=i*rate/8000,sum=0,weight=0;
    var midpoint=Math.floor(center);
    for(var j=midpoint-radius+1;j<=midpoint+radius;j++) {
      var distance=j-center;
      if(Math.abs(distance)>radius)continue;
      var x=2*cutoff*distance;
      var sinc=Math.abs(x)<1e-9?1:Math.sin(Math.PI*x)/(Math.PI*x);
      var window=0.5+0.5*Math.cos(Math.PI*distance/radius);
      var coefficient=2*cutoff*sinc*window;
      var sample=samples[Math.max(0,Math.min(samples.length-1,j))];
      sum+=sample*coefficient;weight+=coefficient;
    }
    out[i]=Math.max(-32768,Math.min(32767,Math.round(sum/weight)));
  }
  return out;
}
// Gemini consumes a canonical 44-byte WAV header followed by signed,
// little-endian 8kHz mono PCM16 samples. Keep ADPCM encoding in the phone app.
function geminiWav8k(samples) {
  var out=new Uint8Array(44+samples.length*2),v=new DataView(out.buffer);
  function tag(p,t){for(var i=0;i<t.length;i++)out[p+i]=t.charCodeAt(i);}
  tag(0,'RIFF');v.setUint32(4,out.length-8,true);tag(8,'WAVE');
  tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
  v.setUint16(22,1,true);v.setUint32(24,8000,true);
  v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  tag(36,'data');v.setUint32(40,samples.length*2,true);
  for(var i=0;i<samples.length;i++)v.setInt16(44+i*2,samples[i],true);
  return out;
}
// Match the phone-side checksum before ADPCM encoding; a corrupt or missing
// base64 chunk must fail instead of being decoded as audible static.
function wavChecksum(bytes) {
  var hash=2166136261>>>0;
  for(var i=0;i<bytes.length;i++) {
    hash=Math.imul((hash^bytes[i])>>>0,16777619)>>>0;
  }
  return hash>>>0;
}
function pcmStats(samples,rate) {
  var peak=0,power=0,zeroCrossings=0,clipped=0,prev=0;
  for(var i=0;i<samples.length;i++){
    var value=samples[i];
    peak=Math.max(peak,Math.abs(value));
    power+=value*value;
    if(i&&((value<0)!==(prev<0)))zeroCrossings++;
    if(Math.abs(value)>=32760)clipped++;
    prev=value;
  }
  return {peak:peak,rms:Math.round(Math.sqrt(power/Math.max(1,samples.length))),
    zero_crossings:zeroCrossings,clipped:clipped,
    duration_ms:Math.round(samples.length*1000/(rate||8000))};
}
// The bridge already knows the real WAV bytes. Compare both PCM16 byte
// interpretations without changing the actual playback signal. Misread
// endianness has dramatically different adjacent-sample roughness.
function inspectPcmByteOrder(bytes,offset,count) {
  var view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  var leDiff=0,beDiff=0,lePower=0,bePower=0,leCross=0,beCross=0;
  var lastLE=0,lastBE=0,n=Math.min(count,24000);
  for(var i=0;i<n;i++) {
    var le=view.getInt16(offset+2*i,true),be=view.getInt16(offset+2*i,false);
    lePower+=le*le;bePower+=be*be;
    if(i) {
      leDiff+=Math.abs(le-lastLE);beDiff+=Math.abs(be-lastBE);
      if((le<0)!==(lastLE<0))leCross++;
      if((be<0)!==(lastBE<0))beCross++;
    }
    lastLE=le;lastBE=be;
  }
  return {examined_samples:n,
    little_endian:{mean_step:Math.round(leDiff/Math.max(1,n-1)),
      rms:Math.round(Math.sqrt(lePower/Math.max(1,n))),crossings:leCross},
    big_endian:{mean_step:Math.round(beDiff/Math.max(1,n-1)),
      rms:Math.round(Math.sqrt(bePower/Math.max(1,n))),crossings:beCross}};
}
function bridgeTestTone() {
  var samples=new Int16Array(8000*7);
  for(var i=0;i<samples.length;i++)
    samples[i]=Math.round(9000*Math.sin(2*Math.PI*440*i/8000));
  return samples;
}
function packageWavSession(pcm,source) {
  var wav=geminiWav8k(pcm);
  if(wav.length>MAX_TTS_BYTES)
    return failure('PLUGIN_UNAVAILABLE','TTS PCM audio exceeds size limit');
  var session=storeTtsSession(wav);
  if(!session)return failure('PLUGIN_UNAVAILABLE','Insufficient plugin storage for TTS audio');
  session.format='pcm_s16le_wav';
  session.sample_rate=8000;
  session.channels=1;
  session.bits_per_sample=16;
  session.sample_count=pcm.length;
  session.wav_checksum=wavChecksum(wav);
  // Return the first already-stored chunk with prepare. This avoids another
  // plugin startup / interprocess round trip before the phone can assemble
  // the first sentence. Older clients simply ignore the optional field.
  session.first_chunk=localStorage.getItem(sessionKey(session.session_id)+'_0');
  session.first_chunk_checksum=wavChecksum(wav.subarray(0,Math.min(wav.length,TTS_CHUNK_BYTES)));
  session.audio_diagnostics={source:source,output:pcmStats(pcm)};
  return {ok:true,data:session};
}
// Binary WAV transport probe. A streaming WAV commonly contains an all-FF
// unknown-length marker; if it turns into all-FD, its bytes were altered in
// transport. The same corruption changes 0x3E80 (16000 Hz) to 0x3EFD.
function looksLikeMangledBinary(bytes) {
  if(bytes.length<44)return false;
  var view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  var pos=12,found=false;
  while(pos+8<=Math.min(bytes.length,4096)){
    var tag=String.fromCharCode(bytes[pos],bytes[pos+1],bytes[pos+2],bytes[pos+3]);
    var length=view.getUint32(pos+4,true);
    if(tag==='data') {
      found=true;
      if(length===0xFDFDFDFD)return true;
      break;
    }
    if(length>bytes.length-pos-8)break;
    pos+=8+length+(length&1);
  }
  return false;
}
async function prepareTts(args){
  if(args.test_tone===true)return packageWavSession(bridgeTestTone(),'bridge_test_tone');
  if(typeof args.text!=='string'||!args.text.trim()||args.text.length>500)
    return failure('INVALID_ARGS','Speech text must contain 1–500 characters');
  var engine=String(args.engine_id||voiceDefaults().tts_engine||'');
  if(!/^tts\.[a-z0-9_]+$/.test(engine))
    return failure('INVALID_ARGS','Select a TTS engine in Home Assistant Bridge settings');
  // Diagnostic override compares native HA 16kHz with the legacy 8kHz
  // request, with cache disabled to prevent stale audio from masking issues.
  var sourceRate=args.source_rate===16000?16000:8000;
  var diagnostic=args.diagnostic===true;
  var timingStart=Date.now();
  var token=await Pebble.secureStorage.getItem(TOKEN_KEY);
  var stage='start',generatedAt=0,downloadedAt=0;
  var bytes=null,binaryTransport='fetch_arraybuffer';
  // HA can transiently return HTTP 500 for a TTS proxy URL during
  // multi-sentence preparation. Regenerate the URL with cache disabled
  // rather than downloading the same (possibly stale) path repeatedly.
  function retryableStatus(code){
    return code===429||code===500||code===502||code===503||code===504;
  }
  for(var attempt=0;attempt<3;attempt++){
    stage='request TTS URL';
    var generated=await api('/api/tts_get_url','POST',{
      engine_id:engine,message:args.text,cache:attempt===0&&!diagnostic,
      options:{preferred_format:'wav',preferred_sample_rate:sourceRate,
        preferred_sample_channels:1,preferred_sample_bytes:2}
    });
    generatedAt=Date.now();
    if(!generated.ok){
      if(attempt<2 && /HTTP (429|500|502|503|504)(?:\b|$)/.test(generated.message||'')){
        await new Promise(function(resolve){setTimeout(resolve,200*(attempt+1));});
        continue;
      }
      return generated;
    }
    var path=generated.data&&generated.data.path;
    if(typeof path!=='string'||!/^\/api\/tts_proxy\/[a-zA-Z0-9_./%-]+$/.test(path))
      return failure('PLUGIN_UNAVAILABLE','Home Assistant did not return a valid TTS path');
    stage='fetch HTTP';
    try {
      // Pebble plugin fetch must request binary responseType ON the request.
      var res=await fetch(baseUrl()+path,{
        headers:{Authorization:'Bearer '+token},
        responseType:'arraybuffer'
      });
      if(!res.ok){
        if(attempt<2 && retryableStatus(res.status)){
          await new Promise(function(resolve){setTimeout(resolve,200*(attempt+1));});
          continue;
        }
        return failure('PLUGIN_UNAVAILABLE','TTS audio HTTP '+res.status);
      }
      stage='fetch arrayBuffer';
      bytes=new Uint8Array(await res.arrayBuffer());
      downloadedAt=Date.now();
      break;
    }catch(e){
      if(attempt<2){
        await new Promise(function(resolve){setTimeout(resolve,200*(attempt+1));});
        continue;
      }
      return failure('PLUGIN_UNAVAILABLE','TTS audio connection failed after retries');
    }
  }
  if(!bytes)return failure('PLUGIN_UNAVAILABLE','TTS audio unavailable after retries');
  try {
    if(looksLikeMangledBinary(bytes))
      return failure('PLUGIN_UNAVAILABLE',
        'Plugin fetch returned an altered WAV header (0xFDFDFDFD). '+
        'Binary audio appears corrupted before parsing; refusing static.');
    if(bytes.length<44||bytes.length>MAX_TTS_BYTES)
      return failure('PLUGIN_UNAVAILABLE','TTS audio is empty or exceeds size limit');
    stage='parse WAV';
    var parsed=wavPcm16(bytes);
    if(!parsed.ok)return failure('PLUGIN_UNAVAILABLE',parsed.error);
    var parsedAt=Date.now();
    stage='resample WAV';
    var pcm=resample8k(parsed.samples,parsed.rate);
    var resampledAt=Date.now();
    stage='store WAV session';
    var result=packageWavSession(pcm,'home_assistant');
    var storedAt=Date.now();
    if(result.ok) {
      result.data.audio_diagnostics.stage_ms={
        ha_generation:generatedAt-timingStart,
        binary_download:downloadedAt-generatedAt,
        wav_parse:parsedAt-downloadedAt,
        resample:resampledAt-parsedAt,
        session_storage:storedAt-resampledAt,
        total_bridge:storedAt-timingStart
      };
      result.data.audio_diagnostics.engine_id=engine;
      result.data.audio_diagnostics.binary_transport=binaryTransport;
      result.data.audio_diagnostics.input_rate=parsed.rate;
      result.data.audio_diagnostics.requested_rate=sourceRate;
      result.data.audio_diagnostics.input=pcmStats(parsed.samples,parsed.rate);
      result.data.audio_diagnostics.byte_order=parsed.byte_order_analysis;
      result.data.audio_diagnostics.declared_data_bytes=parsed.declared_data_bytes;
      result.data.audio_diagnostics.available_data_bytes=parsed.available_data_bytes;
      result.data.audio_diagnostics.used_data_bytes=parsed.used_data_bytes;
      result.data.audio_diagnostics.streamed_data=parsed.streamed_data;
    }
    return result;
  }catch(e){
    var reason=e&&e.name?String(e.name).slice(0,40):'exception';
    var details=e&&e.message?String(e.message):'';
    // Never surface credentials, complete URLs, access tokens or paths.
    details=details.replace(/https?:\/\/\S+/gi,'[address]')
      .replace(/Bearer\s+\S+/gi,'[authorization]')
      .replace(/[A-Za-z0-9_-]{60,}/g,'[redacted]')
      .slice(0,100);
    return failure('PLUGIN_UNAVAILABLE','TTS '+stage+' failed ('+reason+
      ')'+(details?': '+details:''));
  }
}
function ttsChunk(args){
  cleanTtsSessions();
  var id=String(args.session_id||''),offset=Number(args.offset);
  if(!/^tts[a-z0-9]+$/.test(id))return failure('INVALID_ARGS','Invalid TTS session');
  var meta=null;
  try{meta=JSON.parse(localStorage.getItem(sessionKey(id))||'null');}catch(e){}
  if(!meta)return failure('PLUGIN_UNAVAILABLE','TTS session expired; start a new request');
  if(!Number.isInteger(offset)||offset<0||offset>=meta.length||offset%TTS_CHUNK_BYTES!==0)
    return failure('INVALID_ARGS','Invalid TTS chunk offset');
  var index=offset/TTS_CHUNK_BYTES;
  var audio=localStorage.getItem(sessionKey(id)+'_'+index);
  if(!audio)return failure('PLUGIN_UNAVAILABLE','TTS audio chunk unavailable');
  meta.expires=Date.now()+TTS_TTL_MS;
  localStorage.setItem(sessionKey(id),JSON.stringify(meta));
  return {ok:true,data:{offset:offset,length:meta.length,audio:audio,
    checksum:meta.hashes&&meta.hashes[index],
    done:index===meta.count-1}};
}
var SAFE_READ=/^\/api\/(?:config|services|states(?:\/[a-z][a-z0-9_]*\.[a-z0-9_]+)?|calendars|history\/period(?:\/[0-9TZ:+.-]+)?|logbook(?:\/[0-9TZ:+.-]+)?)(?:\?[a-zA-Z0-9_=&%.,:+-]+)?$/;
Pebble.registerActionHandler(async function(request,respond) {
  var args=request.args||{},r,refresh=[];
  switch(request.action){
    case 'get_state':
      if(!safeId(args.entity_id)){respond.error('INVALID_ARGS','Invalid entity_id');return;}
      r=await api('/api/states/'+encodeURIComponent(args.entity_id));break;
    case 'list_states':
      r=await api('/api/states');
      if(r.ok&&Array.isArray(r.data)){
        var domain=args.domain;
        if(domain&&!safePart(domain)){respond.error('INVALID_ARGS','Invalid domain');return;}
        var states=r.data.filter(function(x){return !domain||x.entity_id.indexOf(domain+'.')===0;});
        r.data=states.slice(0,Math.min(100,Math.max(1,Number(args.limit)||50))).map(compact);
      }
      break;
    case 'read_api':
      if(typeof args.path!=='string'||!SAFE_READ.test(args.path)){
        respond.error('INVALID_ARGS','API path not on read-only allowlist');return;
      }
      r=await api(args.path);break;
    case 'get_config':
      r={ok:true,data:voiceDefaults()};break;
    case 'tts_prepare':
      r=await prepareTts(args);break;
    case 'tts_chunk':
      r=ttsChunk(args);break;
    case 'tts_release':
      deleteTtsSession(String(args.session_id||''));
      localStorage.setItem(TTS_INDEX_KEY,JSON.stringify(sessionList().filter(function(id){
        return id!==String(args.session_id||'');
      })));
      r={ok:true,data:{released:true}};break;
    case 'send_to_agent':
      // Index agent destination: the ring's transcript arrives as args.message.
      // chat_id is ignored; the configured default Assist agent handles it.
      args={text:args.message};
      /* falls through */
    case 'conversation':
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000){
        respond.error('INVALID_ARGS','Message must contain 1–4000 characters');return;
      }
      var body={text:args.text,language:'en'};
      var selectedAgent=args.agent_id||voiceDefaults().agent_id;
      if(selectedAgent)body.agent_id=String(selectedAgent);
      if(args.conversation_id)body.conversation_id=String(args.conversation_id);
      r=await api('/api/conversation/process','POST',body);
      if(r.ok){
        var d=r.data||{},speech=d.response&&d.response.speech&&d.response.speech.plain;
        r.data={text:String(speech&&speech.speech||''),conversation_id:d.conversation_id||'',
          response_type:d.response&&d.response.response_type||''};
      }
      break;
    case 'render_template':
      if(typeof args.template!=='string'||args.template.length>4000){
        respond.error('INVALID_ARGS','Template too long');return;
      }
      r=await api('/api/template','POST',{template:args.template});break;
    case 'call_service':
      if(!safePart(args.domain)||!safePart(args.service)){
        respond.error('INVALID_ARGS','Invalid service');return;
      }
      var payload=Object.assign({},args.data||{});
      if(args.target)payload.target=args.target;
      r=await api('/api/services/'+args.domain+'/'+args.service,'POST',payload);
      refresh=['agent/entity'];break;
    case 'fire_event':
      if(!safePart(args.event_type)){respond.error('INVALID_ARGS','Invalid event type');return;}
      r=await api('/api/events/'+args.event_type,'POST',args.event_data||{});break;
    default:respond.error('INVALID_REQUEST','Unknown action');return;
  }
  if(!r.ok){respond.error(r.code,r.message);return;}
  // Index stores send_to_agent's text as the agent's reply to the transcript: plain Assist speech, not JSON.
  if(request.action==='send_to_agent'){
    var reply=r.data.text||(r.data.response_type==='error'?'Home Assistant could not handle that':'Done');
    // Mirror Assist's reply to the watch. Needs the ShowNotifications permission; the host drops it if denied.
    if(watchRepliesEnabled()&&typeof Pebble.showNotification==='function'){
      try{Pebble.showNotification({layout:{type:'genericNotification',title:'Home Assistant',body:reply.slice(0,500)}});}catch(e){}
    }
    // Assist reports "didn't understand"/"no such device" as HTTP 200 with response_type "error";
    // surface it as a failure so the Index feed doesn't show it as completed.
    if(r.data.response_type==='error'){respond.error('ASSIST_ERROR',reply.slice(0,500));return;}
    respond.ok({text:reply.slice(0,2000)});return;
  }
  // Structured JSON replies are carried in result data; never include credentials.
  respond.ok({text:typeof r.data==='string'?r.data.slice(0,2000):
    JSON.stringify(r.data).slice(0,20000),refreshed:refresh});
  if(refresh.length)Pebble.refreshSources(refresh);
});
Pebble.registerConfigHandler(async function(message,respond){
  switch(message&&message.type){
    case 'status':{
      var hasToken=!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
      respond({url:baseUrl(),hasToken:hasToken,configured:!!baseUrl()&&hasToken,
        allow_local_http:localHttpEnabled(),watch_replies:watchRepliesEnabled()});return;
    }
    case 'save':{
      try{
        var allowHttp=message.allow_local_http===true;
        var url=validBase(message.url,allowHttp);
        if(typeof message.token==='string'&&message.token.trim()){
          await Pebble.secureStorage.setItem(TOKEN_KEY,message.token.trim());
        } else if(!(await Pebble.secureStorage.getItem(TOKEN_KEY))){
          respond({ok:false,error:'Enter a Home Assistant token.'});return;
        }
        localStorage.setItem(HTTP_LOCAL_KEY,allowHttp?'true':'false');
        localStorage.setItem(URL_KEY,url);
        Pebble.refreshSources(SOURCES);
        respond({ok:true,url:url,allow_local_http:allowHttp});return;
      }catch(e){respond({ok:false,error:e.message});return;}
    }
    case 'index_save':
      localStorage.setItem(WATCH_REPLIES_KEY,message.watch_replies===true?'true':'false');
      respond({ok:true,watch_replies:watchRepliesEnabled()});return;
    case 'voice_status':
      respond({ok:true,defaults:voiceDefaults()});return;
    case 'voice_discover':
      respond({ok:true,discovery:await discoverVoice()});return;
    case 'voice_save':
      try {respond({ok:true,defaults:saveVoiceDefaults(message.values||{})});}
      catch(e){respond({ok:false,error:e.message});}
      return;
    case 'test':{
      // Check an inexpensive API endpoint first, then the authenticated
      // configuration endpoint to pinpoint where a 400 originates.
      var ping=await api('/api/');
      if(!ping.ok){
        respond({ok:false,error:ping.message,stage:'/api/'});
        return;
      }
      var result=await api('/api/config');
      respond(result.ok?{ok:true,name:result.data&&result.data.location_name||'Home Assistant'}:
        {ok:false,error:result.message,stage:'/api/config'});
      return;
    }
    case 'forget':
      await Pebble.secureStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(URL_KEY);
      localStorage.removeItem(HTTP_LOCAL_KEY);
      localStorage.removeItem(DEFAULTS_KEY);
      localStorage.removeItem(WATCH_REPLIES_KEY);
      Pebble.refreshSources(SOURCES);
      respond({ok:true});return;
    default:respond({ok:false,error:'Unknown configuration request'});
  }
});
