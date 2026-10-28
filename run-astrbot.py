"""Official AstrBot loader, with this bot's separate user-profile data root."""
import asyncio
import os
import sys
from pathlib import Path

root=Path(__file__).resolve().parent
profile=Path(os.environ['USERPROFILE'])/'.dafeilong-runtime'/'astrbot'
os.environ['ASTRBOT_ROOT']=str(profile)
sys.path.insert(0,str(root.parent/'astrbot-reference'))
sys.path.insert(0,str(profile))
import runtime_bootstrap
runtime_bootstrap.initialize_runtime_bootstrap()
from astrbot.core import LogBroker,LogManager,db_helper,logger
from astrbot.core.initial_loader import InitialLoader

async def main():
    broker=LogBroker()
    LogManager.set_queue_handler(logger,broker)
    await InitialLoader(db_helper,broker).start()

if __name__=='__main__':asyncio.run(main())
