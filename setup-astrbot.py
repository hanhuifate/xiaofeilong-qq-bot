"""Provision only this bot's isolated AstrBot profile; preserve QQ login data."""
import json
import os
import shutil
from pathlib import Path

root=Path(__file__).resolve().parent
home=Path(os.environ['USERPROFILE'])/'.dafeilong-runtime'/'astrbot'
data=home/'data'
data.mkdir(parents=True,exist_ok=True)
(data/'config').mkdir(exist_ok=True)
plugins=data/'plugins'
plugins.mkdir(exist_ok=True)
source=root.parent/'QQ群聊'/'astrbot_plugin_dfl_gateway'
shutil.copytree(source,plugins/source.name,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__'))

def read(file,default):
    if not file.exists():return default
    return json.loads(file.read_text(encoding='utf-8-sig'))

def write(file,value):
    temp=file.with_suffix('.tmp')
    temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    temp.replace(file)

file=data/'cmd_config.json'
config=read(file,{})
config['platform']=[x for x in config.get('platform',[]) if x.get('id')!='dfl-qq']+[
    {'id':'dfl-qq','type':'dfl_onebot_forward','enable':True,'bridge_root':str(root),
     'ws_reverse_host':'127.0.0.1','ws_reverse_port':6199}]
config.setdefault('dashboard',{}).update({'enable':False,'host':'127.0.0.1'})
config.setdefault('provider_settings',{})['enable']=False
config.setdefault('platform_settings',{}).update({
    'empty_mention_waiting':False,'empty_mention_waiting_need_reply':False})
owners=read(root/'data'/'moderation-settings.json',{}).get('owners',[])
if owners:config['admins_id']=list(map(str,owners))
write(file,config)
write(data/'config'/'astrbot_plugin_dfl_gateway_config.json',{'bridge_root':str(root),'platform_id':'dfl-qq'})
print(json.dumps({'profile':str(home),'plugin':source.name,'configured':True}))
