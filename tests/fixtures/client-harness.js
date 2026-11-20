import vm from 'node:vm';
import {editions} from './editions.js';

export function clientHarness(clientEditions=editions){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,classList:{toggle(){}},setAttribute(){},showModal(){this.open=true}});return nodes.get(id)};
 const memory=new Map();let said=[];
 const handlers=new Map();const document={querySelector:node,querySelectorAll(){return []},addEventListener(type,handler){handlers.set(type,handler)}};
 const context=vm.createContext({document,console,AbortController,localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},window:{speechSynthesis:{}},navigator:{},Intl,Date,URL,Blob,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({editions:clientEditions})}),SpeechSynthesisUtterance:class{constructor(text){this.text=text}},speechSynthesis:{cancel(){},speak(u){said.push(u)},getVoices(){return []}}});
 return {context,nodes,node,said,handlers};
}
