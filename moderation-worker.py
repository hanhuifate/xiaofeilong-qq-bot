"""Local JSON-lines RPC: reuse the tested Python permission/approval core.

Only the Node host owns the authenticated OneBot connection. This worker
requests allow-listed API calls through that host; it has no QQ credentials.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path
sys.stdin.reconfigure(encoding='utf-8',errors='strict')
sys.stdout.reconfigure(encoding='utf-8',errors='strict')

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT.parent/'QQ群聊'/'astrbot_plugin_dafeilong'))
from dfl.config import Settings
from dfl.storage import Storage
from dfl.models import Proposal, normalize
from dfl.onebot import OneBotAdapter
from dfl.approval import ApprovalEngine
from dfl.permissions import PermissionEngine
from dfl.moderation import ModerationEngine

pending={}
counter=0
store=None


def emit(data):
    print(json.dumps(data,ensure_ascii=True),flush=True)


async def onebot(action,**params):
    global counter
    counter+=1
    key=f'api-{counter}'
    future=asyncio.get_running_loop().create_future()
    pending[key]=future
    emit({'type':'api','id':key,'action':action,'params':params})
    try:
        return await asyncio.wait_for(future,17)
    finally:
        pending.pop(key,None)


async def handle(command):
    try:
        options=command.get('settings') or {}
        settings=Settings(enabled=True,moderation_enabled=options.get('enabled',True),
            dry_run=options.get('dryRun',False),owners=list(map(str,options.get('owners',[]))),
            approval_seconds=options.get('approvalSeconds',120))
        event=command.get('event') or {}
        if event.get('_private'):
            event={**event,'group_id':None,'message_type':'private'}
        message=normalize(event,'local','大肥龙')
        adapter=OneBotAdapter(onebot)
        permissions=PermissionEngine(settings,adapter)
        approvals=ApprovalEngine(store,settings)
        moderation=ModerationEngine(settings,store,adapter,permissions,approvals)
        method=command['method']
        if method=='context':
            admin=await permissions.administrator(message)
            request_info=await moderation.request_context(message) if admin else []
            members=[]
            member_count=0
            bot_role=None
            other_admins=[]
            if message.group:
                bot=await adapter.invoke('get_group_member_info',group_id=int(message.group),user_id=int(message.self_id),no_cache=True)
                bot_role=bot.get('role')
            if message.group and (admin or bot_role in ('owner','admin')):
                rows=await adapter.invoke('get_group_member_list',group_id=int(message.group))
                member_count=len(rows)
                other_admins=[{'id':str(x.get('user_id')),'role':x.get('role')} for x in rows
                    if str(x.get('user_id'))!=message.self_id and x.get('role') in ('owner','admin')]
                mentions={str(x.get('data',{}).get('qq')) for x in event.get('message',[]) if x.get('type')=='at'}
                text=message.text.casefold()
                relevant=[x for x in rows if str(x.get('user_id')) in mentions|{message.user,message.self_id}
                    or any(len(str(x.get(field) or '').strip())>=2 and str(x.get(field)).casefold() in text for field in ('card','nickname'))]
                selected={str(x.get('user_id')):x for x in relevant+rows[:40]}
                members=[{'id':str(x.get('user_id')),'name':str(x.get('card') or x.get('nickname') or '')[:60],
                          'role':x.get('role')} for x in list(selected.values())[:80]]
            item=await approvals.pending(message.scope,message.user)
            public_pending={'id':item['id'],'user':item['user'],'action':json.loads(item['payload']),
                'confirmationPrompt':approvals.describe(Proposal.model_validate_json(item['payload'])),'expires':item['expires']} if item else None
            result={'enabled':settings.moderation_enabled,'dryRun':settings.dry_run,'administrator':admin,
                'botRole':bot_role,'otherAdministrators':other_admins,
                'memberCount':member_count,
                'soleAdministrator':bot_role in ('owner','admin') and not other_admins,
                'supportedActions':['mute','unmute','kick','recall','announcement','essence','unessence','group_request'] if bot_role in ('owner','admin') else ['friend_request','group_request'] if admin and not message.group else [],
                'configuredOwner':message.user in settings.owners,
                'pending':public_pending, 'requests':request_info,'members':members}
        elif method=='request':
            key=await moderation.request(message)
            result={'requestKey':key,'notifyOwners':settings.owners if key else []}
        elif method=='decision':
            decision=command.get('decision') or {}
            operation=decision.get('operation','none')
            if operation=='propose':
                proposal=Proposal(kind=decision['kind'],target_user=decision.get('targetUser',''),
                    message_id=decision.get('messageId',''),duration=decision.get('duration',600),
                    content=decision.get('content',''),request_key=decision.get('requestKey',''),approve=decision.get('approve',False))
                text=await moderation.propose(message,proposal)
            elif operation=='confirm':
                item=await approvals.pending(message.scope,message.user)
                if not item:
                    raise PermissionError('没有属于你且仍在有效期内的待确认操作。')
                if decision.get('approvalId') and item['id']!=decision['approvalId']:
                    raise PermissionError('待确认操作已经变化，请重新核对后确认。')
                text=await moderation.execute(message,item)
            elif operation=='cancel':
                item=await approvals.pending(message.scope,message.user)
                if decision.get('approvalId') and (not item or item['id']!=decision['approvalId']):
                    raise PermissionError('待确认操作已经变化，没有取消其他操作。')
                await approvals.cancel(message)
                text='好，这次不操作。'
            else:
                raise ValueError('Unsupported moderation decision')
            result={'handled':True,'text':text}
        elif method=='paused':
            result=await store.get(message.scope)
        else:
            raise ValueError('Unsupported worker method')
        if method in ('decision','context'):
            emit({'type':'pendingSnapshot','rows':await store.sql("SELECT scope,user,expires FROM approvals WHERE status='pending' AND expires>?",(time.time(),))})
        emit({'id':command['id'],'result':result})
    except Exception as exc:
        text=str(exc) if isinstance(exc,PermissionError) else '操作对象或参数还不明确，请补充准确的群友或消息。' if isinstance(exc,ValueError) else '管理接口暂时没接上；没有自动重试管理操作。'
        emit({'id':command.get('id'),'error':text,'errorType':type(exc).__name__})


async def main():
    global store
    store=Storage(os.environ.get('DFL_MODERATION_DB') or ROOT/'data'/'moderation.sqlite3')
    emit({'type':'pendingSnapshot','rows':await store.sql("SELECT scope,user,expires FROM approvals WHERE status='pending' AND expires>?",(time.time(),))})
    tasks=set()
    try:
        while True:
            line=await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            try:
                item=json.loads(line)
            except ValueError:
                continue
            if item.get('type')=='apiResult':
                future=pending.get(item.get('id'))
                if future and not future.done():
                    if item.get('error'):
                        future.set_exception(RuntimeError('ONEBOT_API_FAILED'))
                    else:
                        future.set_result(item.get('result'))
            else:
                task=asyncio.create_task(handle(item))
                tasks.add(task);task.add_done_callback(tasks.discard)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        await store.close()


if __name__=='__main__':
    asyncio.run(main())
