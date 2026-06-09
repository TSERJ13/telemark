/**
 * telemark-config.js — shared client config for all pages.
 *
 * Usage: <script src="/telemark-config.js"></script>
 * Then use:  TM.api('/api/...'), TM.post(...), TM.ws(), TM.settings
 *
 * Server switching: when the user changes the server in settings.html,
 * a BroadcastChannel message propagates to all open tabs immediately.
 */
(function(global){
  'use strict';
  const KEY = 'telemark_settings';

  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||'{}'); }catch(_){ return {}; } }
  function save(s){ localStorage.setItem(KEY, JSON.stringify(s)); }

  function base(){
    const s = load();
    if(s.mode==='local'  && s.localUrl)  return s.localUrl.replace(/\/$/,'');
    if(s.mode==='render' && s.renderUrl) return s.renderUrl.replace(/\/$/,'');
    return '';
  }

  function api(path, opts={}){
    const headers = {...(opts.headers||{})};
    // Inject auth tokens if stored
    const chairmanToken = localStorage.getItem('chairman_token');
    const authToken     = localStorage.getItem('telemark_scrutineer_token') || localStorage.getItem('scrutineer_token');
    if(chairmanToken) headers['x-chairman-token'] = chairmanToken;
    if(authToken)     headers['x-auth-token']     = authToken;
    return fetch(base()+path, {...opts, headers}).then(async r=>{
      const d = await r.json();
      if(!r.ok) throw new Error(d.error || r.statusText);
      return d;
    });
  }

  function post(path, body={}){
    return api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  }

  function del(path){
    return api(path,{method:'DELETE'});
  }

  /** Create a WebSocket to the configured server */
  function ws(){
    const b = base();
    let wsUrl;
    if(b){
      wsUrl = b.replace(/^https/,'wss').replace(/^http/,'ws');
    } else {
      wsUrl = (location.protocol==='https:'?'wss':'ws')+'://'+location.host;
    }
    return new WebSocket(wsUrl);
  }

  // Listen for settings changes from other tabs
  try{
    const bc = new BroadcastChannel('telemark');
    bc.onmessage = (e)=>{
      if(e.data?.type==='settings'){
        save(e.data.settings);
        // Notify page if it wants to react
        if(typeof global.onTelemarkSettingsChanged==='function'){
          global.onTelemarkSettingsChanged(e.data.settings);
        }
      }
    };
  }catch(_){}

  global.TM = { api, post, del, ws, get settings(){ return load(); }, base };
})(window);
