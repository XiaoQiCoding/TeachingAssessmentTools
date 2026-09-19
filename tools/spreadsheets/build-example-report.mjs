import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dir=path.join(projectRoot,'outputs','ai-teaching');
const w=Workbook.create();
function make(name,title,widths){let s=w.worksheets.add(name);s.showGridLines=false;let a=s.getRangeByIndexes(0,0,25,widths.length);a.format.font={name:'Microsoft YaHei',size:11,color:'#243247'};a.format.wrapText=true;a.format.verticalAlignment='top';a.format.rowHeight=54;widths.forEach((x,i)=>s.getRangeByIndexes(0,i,25,1).format.columnWidth=x);s.getRangeByIndexes(0,0,1,widths.length).merge();s.getRange('A1').values=[[title]];s.getRange('A1').format.font={size:16,bold:true};s.getRange('A1').format.rowHeight=35;return s;}
function row(s,n,v){s.getRangeByIndexes(n-1,0,1,v.length).values=[v];}
function band(s,n,v){row(s,n,v);s.getRangeByIndexes(n-1,0,1,v.length).format.fill='#334766';s.getRangeByIndexes(n-1,0,1,v.length).format.font={bold:true,color:'#FFFFFF'};s.getRangeByIndexes(n-1,0,1,v.length).format.rowHeight=32;}
const s=make('评估结果','剥西红柿皮 教具学具评估结果',[25,72,57]);
row(s,2,['评估日期','2026-09-06','评估方式：AI 依据教案文字初评']);
row(s,3,['评估依据','《劳动与实践〈剥西红柿〉教学设计 庄培兰 终稿.doc》','文内课题名称：《剥西红柿皮》；定位采用教案章节名称。']);
row(s,4,['评估范围','教具选择、目标对应、分层支持、操作安排及评价方式。','未核实 PPT、视频、嵌入图片及实物，不评价实际教学成效。']);
row(s,5,['综合结论','教具与目标对应较清楚，分层适配有学情依据。建议保留整体组合，优先完善热水环节分工、C 组辅具操作及分层评价。','本次不出百分制总分；设计初评不能作为实物安全认证或效果证明。']);s.getRange('A5:C5').format.rowHeight=86;
band(s,7,['评估方面','评估结果','教案依据 / 限制']);
const rows=[
['目标与主题匹配','西红柿、刀具和菜板直接服务“切十字”“剥皮”等劳动任务；实物操作与目标联系明确。','教学目标；实践操作。'],
['学习者需求适配','考虑了手部控制、力量和触觉需求，提出牙线、夹子等替代工具。工具是否确实降低难度，仍需演示或试用核实。','学情分析；个别化教学。'],
['操作与学习支持','有视频、教师示范、三步骤提示和分层帮助。C 组固定与剥皮的分工不清，需简化动作要求。','梳理剥西红柿皮三步骤；实践操作。提示画面未核实。'],
['数量与课堂使用','8 名学生配备 9 套托盘、菜板和刀具，具备每人一套的数量条件；多出一套的用途建议注明。','学情分析；教学准备。实际分配与摆放未核实。'],
['延伸与评价','安排了家庭烹饪延伸，但未提供使用成效记录；末尾统一评价项未充分体现 C 组替代工具目标。','总结和生活迁移；教学评价。'],
['热水与实物风险','热水处理、取出、冷却后交接的责任与条件未写清，需在实施说明中明确。','实践操作“泡热水”。不凭文字认定实物或操作已安全。']
];rows.forEach((v,i)=>row(s,8+i,v));s.getRange('A8:C13').format.rowHeight=82;
band(s,15,['已体现的优点','说明','证据位置']);
row(s,16,['教具服务具体动作','“切十字”和“剥皮”均有示范、学生操作和提示安排，教具用途清楚。','教学目标；实践操作']);
row(s,17,['分层设计有依据','针对不同动作和触觉需求安排工具与辅助，体现对个体差异的考虑。','学情分析；个别化教学']);
row(s,19,['使用说明','这是对已提交教案文字的设计评估；未写明表示证据不足，不表示现实中一定没有。','本报告不复述儿童姓名；引用位置以章节为准，未推测页码。']);s.getRange('A19:C19').format.rowHeight=70;s.freezePanes.freezeRows(7);
const t=make('建议','优先修改与材料核对',[10,24,53,65,37]);
row(t,2,['说明','先处理前 3 项','问题依据均来自教案文字。','建议是待采用的修改方案，不代表已修改教案。','']);
band(t,4,['顺序','修改内容','依据与发现','具体建议','教案位置']);
const edits=[
[1,'明确热水操作分工','写了倒入热水、浸泡与等待，但未明确操作者、捞取者及交给学生操作的条件。','明确由成人负责热水处理与取出，热水区域与学生操作区分开；冷却并确认可安全触摸后再交给学生。不要将浸泡一分钟视为可以触摸的依据。','实践操作：泡热水'],
[2,'简化 C 组辅具操作','同时写“用筷子固定”“一手扶住”“一手拿夹子”，分工不清；徒手扶住与部分学生的触觉需求不一致。','明确谁固定、谁剥皮，例如成人固定，学生用夹子夹住已掀起的皮缘并拉开。先验证夹子是否易握、易夹、易拉；牙线划十字也需先验证可行性。','学情分析；实践操作：剥皮'],
[3,'采用分层评价方式','C 组目标允许牙线、筷子和夹子，但评价表统一写“能握刀给西红柿切十字”；完成符号不能体现帮助程度。','分别记录所用工具、帮助程度和完成动作。C 组按替代工具目标记录，不以独立握刀为统一条件；同步记录独立、提示、示范或肢体辅助。','教学目标；教学评价'],
[4,'补齐准备清单','文中提及手套、计时器、果皮碗和视觉步骤卡，但准备清单未逐项列明。','补列实际使用的物品、数量，或注明替代用品与呈现方式。','学情分析；教学准备；实践操作；成果展示'],
[5,'注明数量分配','8 名学生，9 套托盘、菜板和刀具；多出一套用途未明确。','若用于教师示范，在清单中注明“学生 8 套，教师示范 1 套”；按实际安排填写。','学情分析；教学准备'],
[6,'核对 C 组人数表述','C 组列出两名学生，后文出现“三名学生抵触徒手”的表述。','核对该描述是指 C 组还是跨组学生，再统一人数或表述范围。','学情分析：C 组'],
[7,'统一学情与前测','A 组学情写可独立完成剥皮，前测剥皮项目显示需要较多支持。','核对前测条件与学情描述；如指不同果蔬、不同处理状态或不同时间，应写明，不直接认定学生已独立掌握本课任务。','教学前测；学情分析：A 组']
];edits.forEach((v,i)=>row(t,i+5,v));t.getRange('A5:E11').format.rowHeight=125;t.freezePanes.freezeRows(4);
await fs.mkdir(dir,{recursive:true});
console.log((await w.inspect({kind:'region',sheetId:'评估结果',range:'A3:C5',maxChars:1700,tableMaxRows:3,tableMaxCols:3})).ndjson);
for(const [i,sh,range] of [[1,s,'A1:C19'],[2,t,'A1:E11']]){let b=await w.render({sheetName:sh.name,range,scale:1,format:'png'});await fs.writeFile(`${dir}/report-preview-${i}.png`,new Uint8Array(await b.arrayBuffer()));}
await(await SpreadsheetFile.exportXlsx(w)).save(`${dir}/剥西红柿皮_教具学具AI评估结果.xlsx`);
