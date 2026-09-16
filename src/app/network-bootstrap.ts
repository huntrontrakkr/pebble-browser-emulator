/** Original, pure QuickJS implementation. No browser objects enter this function. */
export const NETWORK_BOOTSTRAP = String.raw`function(cap) {
  'use strict';
  const {emit, schedule, cancelTimer, byteLength, limits, mode, fixtures} = cap;
  const requests = new Map();
  let nextId = 1;
  const own = Object.hasOwn, parse = JSON.parse;
  const failure = (kind, message) => ({error:kind, message:message || kind});
  function namedError(name, message) { const error = new Error(message); error.name = name; return error; }
  function errorFrom(result) {
    return result.error === 'abort' ? namedError('AbortError', result.message) :
      result.error === 'timeout' ? namedError('TimeoutError', result.message) : new TypeError(result.message);
  }
  function headerName(value) {
    value = String(value).toLowerCase();
    if (!/^[!#$%&'*+.^_\x60|~0-9a-z-]+$/.test(value)) throw new TypeError('Invalid HTTP header name.');
    return value;
  }
  function headerValue(value) {
    value = String(value).trim();
    if (/[\r\n\0]/.test(value)) throw new TypeError('Invalid HTTP header value.');
    return value;
  }
  class Headers {
    constructor(values = {}) {
      this._values = Object.create(null);
      if (values instanceof Headers) values = values._values;
      if (Array.isArray(values)) for (const pair of values) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('Invalid headers.');
        this.append(pair[0], pair[1]);
      }
      else for (const name of Object.keys(values)) this.append(name, values[name]);
    }
    append(name, value) { name = headerName(name); value = headerValue(value); this._values[name] = own(this._values,name) ? this._values[name]+', '+value : value; }
    set(name, value) { this._values[headerName(name)] = headerValue(value); }
    get(name) { return this._values[headerName(name)] ?? null; }
    has(name) { return own(this._values,headerName(name)); }
    delete(name) { delete this._values[headerName(name)]; }
    *entries() { for (const name of Object.keys(this._values).sort()) yield [name,this._values[name]]; }
    *keys() { for (const pair of this.entries()) yield pair[0]; }
    *values() { for (const pair of this.entries()) yield pair[1]; }
    [Symbol.iterator]() { return this.entries(); }
    forEach(fn, self) { for (const [name,value] of this.entries()) fn.call(self,value,name,this); }
  }
  class EventTarget {
    constructor() { this._listeners = new Map(); }
    addEventListener(type, callback, options) {
      if (!callback) return;
      if (typeof callback !== 'function' && typeof callback.handleEvent !== 'function') throw new TypeError('Invalid event callback.');
      type=String(type); if (!this._listeners.has(type)) this._listeners.set(type,new Map());
      this._listeners.get(type).set(callback,!!(options && options.once));
    }
    removeEventListener(type, callback) { this._listeners.get(String(type))?.delete(callback); }
    _dispatch(type, detail={}) {
      const event = {type,target:this,currentTarget:this,...detail};
      if (typeof this['on'+type] === 'function') this['on'+type].call(this,event);
      for (const [callback,once] of [...(this._listeners.get(type) ?? [])]) {
        if (once) this.removeEventListener(type,callback);
        if (typeof callback === 'function') callback.call(this,event); else callback.handleEvent(event);
      }
    }
  }
  class AbortSignal extends EventTarget {
    constructor() { super(); this.aborted=false; this.reason=undefined; }
    throwIfAborted() { if (this.aborted) throw this.reason; }
    static abort(reason) { const controller=new AbortController(); controller.abort(reason); return controller.signal; }
    static timeout(milliseconds) {
      milliseconds=Number(milliseconds);
      if (!Number.isFinite(milliseconds) || milliseconds<0 || milliseconds>limits.networkTimeoutMs) throw new RangeError('Invalid abort timeout.');
      const controller=new AbortController();
      schedule(()=>controller.abort(namedError('TimeoutError','The operation timed out.')),milliseconds,false,[]);
      return controller.signal;
    }
  }
  class AbortController {
    constructor() { this.signal=new AbortSignal(); }
    abort(reason) { if(this.signal.aborted)return; this.signal.aborted=true; this.signal.reason=reason??namedError('AbortError','The operation was aborted.'); this.signal._dispatch('abort'); }
  }
  function normalize(url, options={}) {
    url=String(url);
    if (!/^https?:\/\/[^\s/?#]+/i.test(url) || url.length>4096 || /[\0-\x20]/.test(url)) throw new TypeError('Only absolute HTTP(S) URLs are supported.');
    const method=String(options.method??'GET').toUpperCase();
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new TypeError('Unsupported HTTP method.');
    const headers=Object.fromEntries(new Headers(options.headers).entries());
    let body=options.body??null;
    if (body!==null && typeof body!=='string') throw new TypeError('Only text request bodies are supported.');
    if (body!==null && (method==='GET'||method==='HEAD')) throw new TypeError('GET/HEAD requests cannot contain a body.');
    if (byteLength(JSON.stringify({url,method,headers,body}))>limits.networkRequestBytes) throw new RangeError('Network request size limit exceeded.');
    if (options.credentials && options.credentials!=='omit') throw new TypeError('Credentialed requests are not supported.');
    if (options.mode && options.mode!=='cors') throw new TypeError('Only CORS requests are supported.');
    return {url,method,headers,body};
  }
  function finish(id, result, notifyCancel=false) {
    const item=requests.get(id); if(!item)return false;
    requests.delete(id); cancelTimer(item.timer); cancelTimer(item.fixtureTimer);
    if(notifyCancel)emit({type:'network-cancel',requestId:id});
    item.done(result); return true;
  }
  function begin(request, timeout, done) {
    if(requests.size>=limits.pendingNetworkRequests)throw new Error('Pending network request limit exceeded.');
    const id=nextId++, timeoutMs=timeout>0?Math.min(timeout,limits.networkTimeoutMs):limits.networkTimeoutMs;
    const item={done,timer:0,fixtureTimer:0};requests.set(id,item);
    try {item.timer=schedule(()=>finish(id,failure('timeout','Network request timed out.'),true),timeoutMs,false,[]);}
    catch(error){requests.delete(id);throw error;}
    const captured=emit({type:'network-request',request:{id,...request,timeoutMs}});
    let result,delay=0;
    if(!captured)result=failure('limit','Network request could not be captured within output limits.');
    else if(mode==='fixtures') {
      const fixture=fixtures.find(f=>f.url===request.url&&(f.method??'GET').toUpperCase()===request.method&&(!own(f,'body')||f.body===request.body));
      result=fixture?fixture.response:failure('network','No network fixture matched this request.');
      delay=fixture?.delayMs??0;
    } else if(mode!=='cors')result=failure('disabled','Networking is disabled.');
    if(result) {
      try {item.fixtureTimer=schedule(()=>finish(id,result),delay,false,[]);}
      catch(error){cancelTimer(item.timer);requests.delete(id);throw error;}
    }
    return id;
  }
  class Response {
    constructor(body='', init={}) {
      this.status=Number(init.status??200);
      if(!Number.isInteger(this.status)||this.status<200||this.status>599)throw new RangeError('Invalid response status.');
      this.statusText=String(init.statusText??'');this.headers=new Headers(init.headers);
      this.url=String(init.url??'');this.redirected=!!init.redirected;this.type='basic';
      this.ok=this.status>=200&&this.status<300;this.bodyUsed=false;this._text=String(body??'');
      if(byteLength(this._text)>limits.networkResponseBytes)throw new RangeError('Network response size limit exceeded.');
    }
    text() { if(this.bodyUsed)return Promise.reject(new TypeError('Response body has already been consumed.'));this.bodyUsed=true;return Promise.resolve(this._text); }
    json() { return this.text().then(value=>parse(value)); }
    clone() { if(this.bodyUsed)throw new TypeError('Response body has already been consumed.');return new Response(this._text,this); }
  }
  function fetch(url, options={}) {
    return new Promise((resolve,reject)=>{
      let request;
      try{request=normalize(url,options);}catch(error){reject(error);return;}
      const signal=options.signal;
      if(signal!=null&&!(signal instanceof AbortSignal)){reject(new TypeError('Invalid AbortSignal.'));return;}
      if(signal?.aborted){reject(signal.reason);return;}
      let id=0;
      const abort=()=>finish(id,failure('abort','The operation was aborted.'),true);
      try {
        id=begin(request,0,result=>{
          signal?.removeEventListener('abort',abort);
          if(result.error)reject(result.error==='abort'&&signal?.aborted?signal.reason:errorFrom(result));
          else {try{resolve(new Response(result.body,{...result,url:result.url??request.url}));}catch(error){reject(error);}}
        });
        signal?.addEventListener('abort',abort,{once:true});
      }catch(error){reject(error);}
    });
  }
  class XMLHttpRequest extends EventTarget {
    constructor() {
      super();this._state=0;this._request=null;this._id=0;this._version=0;this._responseType='';this._timeout=0;
      this._headers=new Headers();this._responseHeaders=new Headers();this._text='';this._status=0;this._statusText='';this._url='';
      this.withCredentials=false;
    }
    get readyState(){return this._state;}get status(){return this._status;}get statusText(){return this._statusText;}get responseURL(){return this._url;}
    get timeout(){return this._timeout;}set timeout(value){value=Number(value);if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid timeout.');if(this._id)throw new Error('Changing timeout during a request is unsupported.');this._timeout=value;}
    get responseType(){return this._responseType;}set responseType(value){if(this._id)throw new Error('Request has already been sent.');if(!['','text','json'].includes(value))throw new TypeError('Only text and JSON responses are supported.');this._responseType=value;}
    get responseText(){if(this._responseType==='json')throw new Error('responseText is unavailable for JSON responses.');return this._state>=3?this._text:'';}
    get response(){if(this._responseType==='json'){if(this._state!==4||!this._status)return null;try{return parse(this._text);}catch{return null;}}return this.responseText;}
    _change(state){this._state=state;this._dispatch('readystatechange');}
    open(method,url,async=true,username,password){
      if(async===false)throw new Error('Synchronous XMLHttpRequest is not supported.');
      if(username!==undefined||password!==undefined)throw new Error('Embedded HTTP credentials are not supported.');
      if(this._id){const previous=requests.get(this._id);if(previous)previous.done=()=>{};finish(this._id,failure('abort','Request reopened.'),true);this._id=0;}
      this._version++;this._request=normalize(url,{method});this._headers=new Headers();this._responseHeaders=new Headers();
      this._text='';this._status=0;this._statusText='';this._url='';this._change(1);
    }
    setRequestHeader(name,value){if(this._state!==1||this._id)throw new Error('Request is not open.');this._headers.append(name,value);}
    getResponseHeader(name){return this._state>=2?this._responseHeaders.get(name):null;}
    getAllResponseHeaders(){return this._state>=2?[...this._responseHeaders].map(([k,v])=>k+': '+v+'\r\n').join(''):'';}
    overrideMimeType(){throw new Error('MIME type overrides are not supported.');}
    send(body=null){
      if(this._state!==1||this._id)throw new Error('Request is not open.');
      if(this.withCredentials)throw new Error('Credentialed requests are not supported.');
      const request=normalize(this._request.url,{method:this._request.method,headers:this._headers,body:this._request.method==='GET'||this._request.method==='HEAD'?null:body});
      const version=this._version;
      this._id=begin(request,this._timeout,result=>{
        this._id=0;if(version!==this._version)return;
        if(result.error){this._status=0;this._statusText='';this._url='';this._text='';this._responseHeaders=new Headers();this._change(4);
          if(version!==this._version)return;this._dispatch(result.error==='abort'?'abort':result.error==='timeout'?'timeout':'error');
          if(version===this._version)this._dispatch('loadend');return;}
        this._status=result.status;this._statusText=result.statusText??'';this._url=result.url??request.url;this._responseHeaders=new Headers(result.headers);
        this._change(2);if(version!==this._version)return;
        this._text=result.body??'';this._change(3);if(version!==this._version)return;
        const size=byteLength(this._text);this._dispatch('progress',{lengthComputable:true,loaded:size,total:size});if(version!==this._version)return;
        this._change(4);if(version!==this._version)return;this._dispatch('load');if(version===this._version)this._dispatch('loadend');
      });
      this._dispatch('loadstart');
    }
    abort(){const version=this._version;if(this._id)finish(this._id,failure('abort','The operation was aborted.'),true);if(version!==this._version)return;this._id=0;this._version++;this._state=0;this._status=0;this._statusText='';this._text='';this._url='';this._responseHeaders=new Headers();}
  }
  for(const [name,value]of Object.entries({UNSENT:0,OPENED:1,HEADERS_RECEIVED:2,LOADING:3,DONE:4})){
    Object.defineProperty(XMLHttpRequest,name,{value});Object.defineProperty(XMLHttpRequest.prototype,name,{value});
  }
  Object.assign(globalThis,{fetch,Headers,Response,XMLHttpRequest,AbortController,AbortSignal});
  return Object.freeze({respond(id,json){return finish(id,parse(json));}});
}`;
