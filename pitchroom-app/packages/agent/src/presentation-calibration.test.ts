import {expect,it} from 'vitest';
import {ResponsesPositioningRunner,buildDeterministicPositioning} from './positioning-runner';
import {ResponsesDeckRunner,buildDeterministicDeck} from './deck-runner';
import {coreMessageJsonSchema,coreMessageSystemPrompt} from './core-message-contract';
import {coreMessageWireFixture,liveDeckWireFixture} from './presentation.testkit';
const input={understandingVersionId:'u',chunks:[{id:'c',sourceId:'s',text:'Interview notes link to exact quotations.',startOffset:0,endOffset:40}],understanding:{schemaVersion:1 as const,themes:[{title:'Value',summary:'Trace recommendations to quotes; target unknown.',claims:[{statement:'Notes link to quotes.',evidenceState:'supported' as const,evidence:[{sourceId:'s',chunkId:'c',quote:'exact quotations'}],userInputIds:[]}]}],gaps:[{description:'Budget unknown',whyItMatters:'Scope',relatedSourceIds:['s']}],nextQuestion:{question:'What defines success?',whyItMatters:'Evaluation',relatedThemeIndexes:[0]}}};
const response=(value:unknown)=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}),{status:200});
const positioning=buildDeterministicPositioning(input);
it('uses the same prompt and JSON schema as the standalone evaluator and maps citations to actual chunks',async()=>{
 const wire=coreMessageWireFixture(positioning);wire.hypotheses[0]!.unknowns=['Budget unknown'];let request:any;
 const result=await new ResponsesPositioningRunner({apiKey:'offline',model:'offline',baseURL:'https://offline.invalid',fetch:async(_u,init)=>{request=JSON.parse(String(init?.body));return response(wire);}}).run(input);
 expect(request.input[0].content).toBe(coreMessageSystemPrompt);expect(request.text.format.schema).toEqual(coreMessageJsonSchema);
 expect(result.directions[0]!.evidence[0]!.chunkId).toBe('c');expect(result.directions[0]!.unknowns).toEqual(['Budget unknown']);expect(result.originalFraming.coreMessage).toBe(input.understanding.themes[0]!.summary);
});
it.each(['long slogan','same lens','same slogan','missing recommendation'] as const)('rejects %s on the web path using unchanged Core Message hard gates',async kind=>{
 const wire:any=coreMessageWireFixture(positioning);
 if(kind==='long slogan')wire.hypotheses[0].coreMessage='one two three four five six seven eight nine ten eleven twelve thirteen';
 if(kind==='same lens')wire.hypotheses[1].lens='mechanism';
 if(kind==='same slogan')wire.hypotheses[1].coreMessage=wire.hypotheses[0].coreMessage;
 if(kind==='missing recommendation')delete wire.recommendation;
 await expect(new ResponsesPositioningRunner({apiKey:'offline',model:'offline',baseURL:'https://offline.invalid',fetch:async()=>response(wire)}).run(input)).rejects.toThrow();
});
const deckInput={...input,positioningVersionId:'p',positioning,appliedDirectionId:positioning.directions[0]!.id};
it.each(['wordy body','changed headline','writing advice','missing notes'] as const)('rejects generated Deck %s without changing source state',async kind=>{
 const wire:any=liveDeckWireFixture(buildDeterministicDeck(deckInput),positioning.directions[0]!.coreMessage),before=structuredClone(deckInput);
 if(kind==='wordy body')wire.pages[1].body=Array(46).fill('word').join(' ');
 if(kind==='changed headline')wire.pages[0].title='An unapproved rewrite';
 if(kind==='writing advice')wire.pages[1].body='The deck should explain the product.';
 if(kind==='missing notes')delete wire.pages[1].speakerNotes;
 await expect(new ResponsesDeckRunner({apiKey:'offline',model:'offline',baseURL:'https://offline.invalid',fetch:async()=>response(wire)}).run(deckInput)).rejects.toThrow();expect(deckInput).toEqual(before);
});
