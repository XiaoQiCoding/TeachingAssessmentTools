// Shared by the report API, saved-report views and workbook exports.
function normalizeClassroomScores(report) {
  if (!report || !Array.isArray(report.dimensions)) return report;
  const labels=['课堂参与表现','学习理解支持','操作与分层适配','技能习得与泛化','情绪行为影响'];
  let repaired=false;
  report.dimensions=labels.map((label,index)=>{
    const id='B'+(index+1),row={label,criterion:'',...(report.dimensions.find(item=>item.id===id)||{}),id,weight:12,max_score:5};
    row.evidence=Array.isArray(row.evidence)?row.evidence:[];
    const valid=row.score!==null&&row.score!==undefined&&row.score!==''&&Number.isFinite(Number(row.score));
    if(!valid||(id==='B5'&&row.status==='insufficient_evidence')){
      const negative=(report.audit?.scoring_events||[]).some(e=>e.phase==='tool_use'&&['emotion','avoidance'].includes(e.type)&&e.outcome==='negative');
      row.score=id==='B5'&&!negative?5:0;row.provisional=true;repaired=true;
      row.score_explanation=row.finding=id==='B5'&&!negative?'当前采纳记录未出现明确的负向情绪行为，按无异常规则计5分；不代表已核实全课情绪稳定。':'现有记录不足以判断本项完成质量，按0分初评计入总分；不等同于已观察到学生表现不合格。';
      row.next_level_gap='可在后续核对实际课堂表现后调整分数。';
    }
    row.score=Math.max(0,Math.min(5,Number(row.score)));
    row.weighted_score=Math.round(row.score/5*12*10)/10;
    row.status=row.score>=4?'supported':row.score>=3?'mixed':'concern';
    return row;
  });
  report.module_b_score=Math.round(report.dimensions.reduce((sum,row)=>sum+row.weighted_score,0)*10)/10;
  report.observed_weighted_score=report.module_b_score;report.scored_weight=60;report.status='complete';
  if(repaired||report.score_policy!=='numeric-b-v1'){
    report.summary='B1—B5五项均已评分；B5未出现明确负向情绪行为按5分，其他无法判断项按0分初评。';
    report.score_note='模块B总分 '+report.module_b_score+'/60；单项分÷5×12后相加。0分初评和B5无异常默认分均为评分规则，不补造课堂证据；覆盖与复核范围另见说明。';
  }
  report.score_policy='numeric-b-v1';
  return report;
}
