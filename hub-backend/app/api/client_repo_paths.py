"""Member-managed Git repository → local path mappings (issue #495, 方案二)."""
from fastapi import APIRouter, Body, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import client_repo_paths as svc

router = APIRouter(prefix="/api/v1/client-repo-paths", tags=["client-repo-paths"])


@router.get("")
async def list_repo_paths(client: Client = Depends(current_client)):
    return {"paths": svc.list_paths(client)}


@router.put("")
async def set_repo_path(body: dict = Body(...), client: Client = Depends(current_client),
                        session: AsyncSession = Depends(get_session)):
    rows = svc.set_path(client, body.get("gitUrl"), body.get("localPath"))
    await session.commit()
    return {"paths": rows}


@router.delete("")
async def delete_repo_path(body: dict = Body(...), client: Client = Depends(current_client),
                           session: AsyncSession = Depends(get_session)):
    rows = svc.remove_path(client, body.get("gitUrl"))
    await session.commit()
    return {"paths": rows}
