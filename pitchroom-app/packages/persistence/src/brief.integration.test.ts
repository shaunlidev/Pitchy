import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, PitchroomRepository } from "./repository";
import { BriefRepository } from "./brief-repository";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for brief integration tests.");
const { client, db } = createDatabase(url);
const materials = new PitchroomRepository(db);
const briefs = new BriefRepository(db);
beforeAll(async () => { await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname }); });
afterAll(async () => client.end());
const save = (projectId: string, expectedVersionId: string | null, text: string, commandId = crypto.randomUUID()) => briefs.save(projectId, { expectedVersionId, text, commandId });
it("keeps one current brief, retains prior text and makes clear a versioned context removal", async () => {
 const project=await materials.createProject("Brief history QA");
 await save(project.id,null,"原话 first brief");const first=await briefs.read(project.id);
 await save(project.id,first.head!.id,"Second brief");const second=await briefs.read(project.id);
 expect(second.versions.map(v=>v.entry)).toEqual([expect.objectContaining({kind:"saved",text:"原话 first brief"}),expect.objectContaining({kind:"saved",text:"Second brief"})]);
 expect(await materials.listSources(project.id)).toEqual([expect.objectContaining({kind:"brief",chunks:[expect.objectContaining({text:"Second brief"})]})]);
 const commandId=crypto.randomUUID();await save(project.id,second.head!.id,"",commandId);await save(project.id,second.head!.id,"",commandId);
 const cleared=await briefs.read(project.id);expect(cleared.versions).toHaveLength(3);expect(cleared.head?.entry).toEqual({kind:"cleared"});expect(await materials.listSources(project.id)).toEqual([]);
 expect(await materials.getProject(project.id)).toMatchObject({phase:"empty",currentUnderstandingId:null,currentPositioningId:null});
});
it("does not take over a same-name/same-content imported file when saving or clearing the brief", async () => {
 const project=await materials.createProject("Independent brief/file QA");const input={name:"written-brief.md",mediaType:"text/markdown",text:"Same exact material."} satisfies Parameters<PitchroomRepository["addMaterial"]>[1];
 const file=await materials.addMaterial(project.id,input,"file-input");await save(project.id,null,input.text);const current=await briefs.read(project.id);
 expect((await materials.listSources(project.id)).map(source=>source.kind).sort()).toEqual(["brief","file"]);
 if(current.head?.entry.kind!=="saved")throw Error("Missing saved brief");expect(current.head.entry.sourceId).not.toBe(file.id);
 await expect(materials.removeMaterial(project.id,current.head.entry.sourceId)).rejects.toMatchObject({code:"NOT_FOUND"});
 await save(project.id,current.head.id,"");expect(await materials.listSources(project.id)).toEqual([expect.objectContaining({id:file.id,kind:"file",chunks:[expect.objectContaining({text:input.text})]})]);
});
it("serializes two stale writers, supports receipt replay and never lets an old save overwrite the new head", async () => {
 const project=await materials.createProject("Concurrent brief QA");await save(project.id,null,"First");const first=await briefs.read(project.id);
 const a={expectedVersionId:first.head!.id,text:"Writer A",commandId:crypto.randomUUID()},b={expectedVersionId:first.head!.id,text:"Writer B",commandId:crypto.randomUUID()};
 const results=await Promise.allSettled([briefs.save(project.id,a),briefs.save(project.id,b)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
 const current=await briefs.read(project.id);expect(current.versions).toHaveLength(2);const winner=results[0]!.status==="fulfilled"?a:b;await briefs.save(project.id,winner);expect(await briefs.read(project.id)).toEqual(current);
 await expect(briefs.save(project.id,{...winner,text:"Different body"})).rejects.toMatchObject({code:"CONFLICT"});expect(await briefs.read(project.id)).toEqual(current);
});
it("counts retained content against quota while reusing a previously saved brief without duplicating it", async () => {
 const project=await materials.createProject("Brief quota QA");const bounded=new BriefRepository(db,20);
 await bounded.save(project.id,{expectedVersionId:null,text:"1234567890",commandId:crypto.randomUUID()});let current=await bounded.read(project.id);
 await bounded.save(project.id,{expectedVersionId:current.head!.id,text:"abcdefghij",commandId:crypto.randomUUID()});current=await bounded.read(project.id);
 await expect(bounded.save(project.id,{expectedVersionId:current.head!.id,text:"over quota content",commandId:crypto.randomUUID()})).rejects.toMatchObject({code:"INVALID_INPUT"});expect(await bounded.read(project.id)).toEqual(current);
 await bounded.save(project.id,{expectedVersionId:current.head!.id,text:"1234567890",commandId:crypto.randomUUID()});const restored=await bounded.read(project.id);expect(restored.versions).toHaveLength(3);expect(restored.head?.entry).toEqual(restored.versions[0]!.entry);expect(await materials.listSources(project.id)).toHaveLength(1);
});
