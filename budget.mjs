/** Budget reservations cover all routes, including retries and owner reviews. */
export class UsageBudget {
  constructor(cfg,store,update=()=>{}) {
    this.cfg=cfg;this.store=store;this.update=update;
    this.settings={enabled:true,maxHourlyTokens:2000000,maxDailyTokens:8000000,maxDailyCost:0,
      reserveTokens:64000,inputPerMillion:0,cachedPerMillion:0,outputPerMillion:0,...cfg.budget,...store?.setting('global','budget')};
    store?.recoverReservations();
  }
  price(usage) {
    const s=this.settings,input=Math.max(0,Number(usage?.input_tokens)||0),cached=Math.min(input,Math.max(0,Number(usage?.cached_input_tokens)||0));
    return ((input-cached)*s.inputPerMillion+cached*s.cachedPerMillion+(Number(usage?.output_tokens)||0)*s.outputPerMillion)/1000000;
  }
  summary() {
    return {enabled:!!this.settings.enabled,day:this.store?.totals(),hour:this.store?.totals(Date.now()-3600000),limits:this.settings,
      pricingConfigured:this.settings.inputPerMillion>0||this.settings.outputPerMillion>0};
  }
  wrap(answer) {
    const wrapped=async(cfg,question,history,context,retry=0)=>{
      if(!this.store)return answer(cfg,question,history,context);
      const cooldown=this.store.setting('global','providerCooldown');
      if(cooldown?.until>Date.now()&&!context.forceProbe)return {shouldReply:false,text:'这会儿模型额度到限了，恢复后再聊。',providerUnavailable:true};
      const estimate=Math.max(4000,this.settings.reserveTokens);
      let reservation;
      try {
        reservation=this.store.reserve(estimate,this.price({input_tokens:estimate}),this.settings.enabled?this.settings:{});
      } catch(error) {
        if(!/_BUDGET$/.test(error.message))throw error;
        this.update({lastBudgetLimit:error.message});
        this.store.audit(context.chatKey,context.requesterId,'budget_blocked',{reason:error.message});
        return {shouldReply:context.mode==='direct',text:context.mode==='direct'?'今天这会儿的对话额度到上限了，等额度恢复再继续聊。':'',budgetBlocked:true};
      }
      try {
        const result=await answer(cfg,question,history,context);
        if(cooldown){this.store.setting('global','providerCooldown',null);this.update({providerUnavailable:false,providerCooldownUntil:null});}
        this.store.settle(reservation,context.chatKey,result.usage,this.summary().pricingConfigured?this.price(result.usage):(result.estimatedCostUsd||0),{model:cfg.model,provider:result.provider,route:context.webSearchAllowed?'web':'chat',pricingConfigured:this.summary().pricingConfigured||Number.isFinite(result.estimatedCostUsd)});
        return result;
      }catch(error){
        if(error.message==='MODEL_USAGE_LIMIT') {
          this.store.settle(reservation,context.chatKey,{input_tokens:0,cached_input_tokens:0,output_tokens:0},0,{model:cfg.model,rejectedBeforeGeneration:true,failed:true});
          const until=Date.now()+300000;this.store.setting('global','providerCooldown',{until,reason:error.message});
          this.update({providerUnavailable:true,providerCooldownUntil:until,lastError:'MODEL_USAGE_LIMIT'});
          return {shouldReply:false,text:'这会儿模型额度到限了，恢复后再聊。',providerUnavailable:true};
        }
        const usage=error.usage||(error.rejectedBeforeGeneration?{input_tokens:0,cached_input_tokens:0,output_tokens:0}:null);
        this.store.settle(reservation,context.chatKey,usage,this.summary().pricingConfigured?this.price(usage):(error.estimatedCostUsd||0),
          {model:cfg.model,provider:error.provider,failed:true,reason:error.message,usageUnknown:!usage,pricingConfigured:this.summary().pricingConfigured||Number.isFinite(error.estimatedCostUsd)});
        if(!error.retryHandled&&retry<1&&/^(?:COMPATIBLE_API_HTTP_(?:429|502|503|504)|CODEX_SERVER_OFFLINE|CODEX_SERVER_EXITED)$/.test(error.message)) {
          this.store.audit(context.chatKey,context.requesterId,'model_retry',{reason:error.message});
          await new Promise(resolve=>setTimeout(resolve,1000));return wrapped(cfg,question,history,context,retry+1);
        }
        throw error;
      }
    };
    Object.assign(wrapped,answer);
    return wrapped;
  }
}
