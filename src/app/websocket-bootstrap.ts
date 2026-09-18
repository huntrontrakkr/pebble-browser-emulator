/** Original bounded WebSocket surface inside QuickJS. Browser sockets stay in the host Worker. */
export const WEBSOCKET_BOOTSTRAP = String.raw`function(cap) {
  'use strict';
  const {emit,schedule,cancelTimer,byteLength,limits,mode,normalizeUrl}=cap;
  const sockets=new Map();let nextId=1;
  function error(name,message){const e=new Error(message);e.name=name;return e;}
  function bytes(value){
    if(value instanceof ArrayBuffer)return Array.from(new Uint8Array(value));
    if(ArrayBuffer.isView(value))return Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
    if(value instanceof SocketBlob)return value._bytes.slice();
    const result=[];
    for(const ch of String(value)){let c=ch.codePointAt(0);if(c>=0xd800&&c<=0xdfff)c=0xfffd;
      if(c<128)result.push(c);else if(c<2048)result.push(192|(c>>6),128|(c&63));
      else if(c<65536)result.push(224|(c>>12),128|((c>>6)&63),128|(c&63));
      else result.push(240|(c>>18),128|((c>>12)&63),128|((c>>6)&63),128|(c&63));}
    return result;
  }
  function decode(b){
    let text='';for(let i=0;i<b.length;){const a=b[i++];if(a<128){text+=String.fromCharCode(a);continue;}
      const n=a>=0xc2&&a<=0xdf?1:a>=0xe0&&a<=0xef?2:a>=0xf0&&a<=0xf4?3:0;
      if(!n){text+='\ufffd';continue;}let c=a&((1<<(6-n))-1),used=0;
      while(used<n && i<b.length && b[i]>=128 && b[i]<=191){const v=b[i];if(used===0&&((a===0xe0&&v<160)||(a===0xed&&v>159)||(a===0xf0&&v<144)||(a===0xf4&&v>143)))break;c=(c<<6)|(v&63);i++;used++;}
      text+=used===n?String.fromCodePoint(c):'\ufffd';}return text;
  }
  class SocketBlob {
    constructor(parts=[],options={}){let out=[];for(const p of parts){out=out.concat(bytes(p));if(out.length>limits.socketMessageBytes)throw new RangeError('Blob size limit exceeded.');}this._bytes=out;this._type=/[^\x20-\x7e]/.test(String(options.type??''))?'':String(options.type??'').toLowerCase();}
    get size(){return this._bytes.length;}get type(){return this._type;}
    arrayBuffer(){return Promise.resolve(Uint8Array.from(this._bytes).buffer);}text(){return Promise.resolve(decode(this._bytes));}
    slice(start=0,end=this.size,type=''){return new SocketBlob([Uint8Array.from(this._bytes.slice(start,end))],{type});}
  }
  function dispatch(socket,type,detail={}){
    const event={type,target:socket,currentTarget:socket,...detail};
    if(typeof socket['on'+type]==='function')socket['on'+type].call(socket,event);
    for(const [fn,once] of [...(socket._listeners.get(type)??[])]){if(once)socket.removeEventListener(type,fn);if(typeof fn==='function')fn.call(socket,event);else fn.handleEvent(event);}
  }
  function terminal(socket,detail,failed=false){
    if(socket._state===3)return;socket._state=3;sockets.delete(socket._id);cancelTimer(socket._timer);
    try{if(failed)dispatch(socket,'error',{message:detail.message??'WebSocket connection failed.'});}
    finally{dispatch(socket,'close',{code:detail.code??1006,reason:detail.reason??'',wasClean:!!detail.wasClean});}
  }
  class WebSocket {
    constructor(url,protocols=[]){
      const normalized=normalizeUrl(String(url));
      if(normalized.error)throw error('SyntaxError',normalized.error);
      url=normalized.url;
      if(typeof protocols==='string')protocols=[protocols];else protocols=Array.from(protocols);
      if(protocols.length>16||protocols.some(p=>typeof p!=='string'||p.length>256||! /^[!#$%&'*+.^_\x60|~0-9a-z-]+$/i.test(p))||new Set(protocols).size!==protocols.length)throw error('SyntaxError','Invalid WebSocket subprotocols.');
      if(sockets.size>=limits.pendingSockets)throw new Error('Pending WebSocket limit exceeded.');
      this._id=nextId++;this._url=url;this._state=0;this._binaryType='blob';this._protocol='';this._extensions='';this._queued=0;this._nativeBuffered=0;this._listeners=new Map();this._timer=0;
      sockets.set(this._id,this);
      try{this._timer=schedule(()=>{emit({type:'websocket-command',socketId:this._id,action:'close'});terminal(this,{message:'WebSocket connection timed out.'},true);},limits.socketTimeoutMs,false,[]);
        const recorded=emit({type:'websocket-command',socketId:this._id,action:'open',url,protocols});
        if(!recorded||mode!=='cors')schedule(()=>terminal(this,{message:recorded?'WebSocket networking is disabled.':'WebSocket output limit exceeded.'},true),0,false,[]);
      }catch(e){sockets.delete(this._id);cancelTimer(this._timer);throw e;}
    }
    get url(){return this._url;}get readyState(){return this._state;}get protocol(){return this._protocol;}get extensions(){return this._extensions;}
    get bufferedAmount(){return this._queued+this._nativeBuffered;}
    get binaryType(){return this._binaryType;}set binaryType(v){if(v==='blob'||v==='arraybuffer')this._binaryType=v;}
    addEventListener(type,fn,options){if(!fn)return;if(typeof fn!=='function'&&typeof fn.handleEvent!=='function')throw new TypeError('Invalid listener.');type=String(type);if(!this._listeners.has(type))this._listeners.set(type,new Map());this._listeners.get(type).set(fn,!!options?.once);}
    removeEventListener(type,fn){this._listeners.get(String(type))?.delete(fn);}
    send(value){
      if(this._state===0)throw error('InvalidStateError','WebSocket is connecting.');
      const binary=value instanceof ArrayBuffer||ArrayBuffer.isView(value)||value instanceof SocketBlob;
      const data=binary?bytes(value):decode(bytes(String(value))),length=binary?data.length:byteLength(data);
      if(length>limits.socketMessageBytes||this.bufferedAmount+length>limits.socketBufferedBytes)throw new RangeError('WebSocket buffer limit exceeded.');
      this._queued+=length;if(this._state!==1)return;
      if(!emit({type:'websocket-command',socketId:this._id,action:'send',data})){this._queued-=length;throw new Error('WebSocket output limit exceeded.');}
    }
    close(code,reason=''){
      if(code!==undefined&&(!Number.isInteger(code)||(code!==1000&&(code<3000||code>4999))))throw error('InvalidAccessError','Invalid WebSocket close code.');
      reason=decode(bytes(String(reason)));if(byteLength(reason)>123)throw error('SyntaxError','WebSocket close reason exceeds 123 bytes.');
      if(this._state>=2)return;const connecting=this._state===0;this._state=2;
      if(!emit({type:'websocket-command',socketId:this._id,action:'close',...(code===undefined?{}:{code}),reason})||mode!=='cors')schedule(()=>terminal(this,{code:1006},connecting),0,false,[]);
    }
  }
  for(const [name,value] of Object.entries({CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3})){Object.defineProperty(WebSocket,name,{value,enumerable:true});Object.defineProperty(WebSocket.prototype,name,{value,enumerable:true});}
  globalThis.WebSocket=WebSocket;globalThis.Blob=SocketBlob;
  return Object.freeze({receive(id,event){
    const s=sockets.get(id);if(!s)return false;
    if(event.type==='open'){if(s._state!==0)return false;cancelTimer(s._timer);s._state=1;s._protocol=event.protocol??'';s._extensions=event.extensions??'';dispatch(s,'open');}
    else if(event.type==='message'){if(s._state!==1)return false;const data=Array.isArray(event.data)?(s.binaryType==='arraybuffer'?Uint8Array.from(event.data).buffer:new SocketBlob([Uint8Array.from(event.data)])):event.data;dispatch(s,'message',{data,origin:s.url.match(/^wss?:\/\/[^/]+/i)?.[0]??''});}
    else if(event.type==='buffered'){s._queued=Math.max(0,s._queued-(event.sentBytes??0));s._nativeBuffered=event.bufferedAmount;}
    else if(event.type==='error'){dispatch(s,'error',{message:event.message??'WebSocket connection failed.'});}
    else if(event.type==='close')terminal(s,event);
    return true;
  }});
}`;
