// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {readPositioning} from "@pitchroom/domain";
import {FramingChoiceCards,FramingWordingEditor} from "./framing-choices";
import {acceptFixture,addFixtureMaterial,applyFixturePositioning,generateFixtureDeck,generateFixturePositioning,readFixtureState,resetFixtureState,runFixtureAgent,saveFixturePositioningWording,undoFixturePositioning} from "./fixture-store";
afterEach(()=>{cleanup();window.localStorage.clear();});
function setup(){resetFixtureState();addFixtureMaterial({name:"client.md",mediaType:"text/markdown",text:"We help buyers inspect the source before making a decision."});const understood=runFixtureAgent();acceptFixture(understood.project.revision);return generateFixturePositioning();}
it("offers accepted interpretation honestly and invents no source wording",async()=>{
 const state=setup(),onAction=vi.fn(()=>true);render(<FramingChoiceCards state={state} busy={false} onAction={onAction}/>);
 expect(screen.getByRole("heading",{name:"Accepted interpretation"})).toBeTruthy();expect(screen.queryByRole("heading",{name:/Original wording/})).toBeNull();expect(screen.getByText(/No original source wording has been selected/)).toBeTruthy();expect(onAction).not.toHaveBeenCalled();
 await userEvent.setup().click(screen.getByRole("button",{name:"Keep accepted interpretation"}));expect(onAction).toHaveBeenCalledWith(expect.objectContaining({action:"apply_positioning",directionId:"original",expectedPositioning:readPositioning(state.positioning!).head}));
});
it("retains manual spaces and line breaks through save, explicit Apply, history, Undo and a new Deck",()=>{
 let state=setup();const revision=state.project.revision;state=applyFixturePositioning(state.positioning!.proposal.directions[0]!.id,revision);const original=structuredClone(state.positioning!);state=generateFixtureDeck(revision);const oldDeck=structuredClone(state.deck!);
 const text="  My exact words\nare a human judgment.  ";const input:Parameters<typeof saveFixturePositioningWording>[0]={wording:{kind:"manual_exact",text},expectedRevision:revision,expectedPositioning:readPositioning(state.positioning!).head,commandId:"manual-save"};
 state=saveFixturePositioningWording(input);expect(readPositioning(state.positioning!).applied).toEqual(readPositioning(original).applied);expect(state.positioningVersions.find(v=>v.id===original.id)).toEqual(original);expect(state.deck?.proposal).toEqual(oldDeck.proposal);
 const choice=state.positioning!.proposal.retainedChoices!.at(-1)!;expect(choice.text).toBe(text);const before=readPositioning(state.positioning!).head;state=applyFixturePositioning(choice.id,revision,before,"manual-apply");expect(readPositioning(state.positioning!).applied?.choice.text).toBe(text);
 expect(()=>applyFixturePositioning("original",revision,before,"stale-apply")).toThrow(/changed/);expect(state.deck?.proposal).toEqual(oldDeck.proposal);
 state=generateFixtureDeck(revision);expect(state.deck!.proposal.pages[0]!.title).toBe(text);expect(state.deckVersions.find(d=>d.id===oldDeck.id)?.proposal).toEqual(oldDeck.proposal);
 state=undoFixturePositioning(revision);expect(readPositioning(state.positioning!).applied?.choice.text).toBe(readPositioning(original).applied?.choice.text);
 const count=state.positioningVersions.length;state=saveFixturePositioningWording(input);expect(state.positioningVersions).toHaveLength(count);expect(()=>saveFixturePositioningWording({...input,wording:{kind:"manual_exact",text:"Changed command payload"}})).toThrow(/reused/);
});
it("binds selected source wording to its actual passage and preserves an independent manual draft",async()=>{
 const state=setup();const onAction=vi.fn(()=>true);render(<FramingWordingEditor state={state} busy={false} onAction={onAction}/>);const user=userEvent.setup();await user.click(screen.getByText("Keep source wording or your exact words"));
 const manual="  Keep this unsent manual draft.\n";fireEvent.change(screen.getByLabelText("Your exact positioning wording"),{target:{value:manual}});
 await user.selectOptions(screen.getByLabelText("Wording type"),"source_quote");const chunk=state.sources[0]!.chunks[0]!;await user.selectOptions(screen.getByLabelText("Source passage for wording"),chunk.id);await user.click(screen.getByRole("button",{name:"Save wording candidate"}));
 expect(onAction).toHaveBeenCalledWith(expect.objectContaining({action:"save_positioning_wording",wording:{kind:"source_quote",sourceId:state.sources[0]!.sourceId,chunkId:chunk.id,start:0,end:chunk.text.length,text:chunk.text}}));
 await user.selectOptions(screen.getByLabelText("Wording type"),"manual_exact");expect(screen.getByLabelText("Your exact positioning wording")).toHaveProperty("value",manual);
});
it("rejects an invented source quote without changing the applied choice or history",()=>{
 const state=setup(),before=structuredClone(state);const source=state.sources[0]!,chunk=source.chunks[0]!;
 expect(()=>saveFixturePositioningWording({wording:{kind:"source_quote",sourceId:source.sourceId,chunkId:chunk.id,start:0,end:8,text:"Invented"},expectedRevision:state.project.revision,expectedPositioning:readPositioning(state.positioning!).head,commandId:"bad-quote"})).toThrow(/unavailable|changed/);
 expect(readFixtureState()).toEqual(before);
});
