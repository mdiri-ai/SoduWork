"""Shared administrative boundaries for repository mapping and automatic batches."""
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import rbac


@dataclass(frozen=True)
class ManagementScope:
    org_ids: set[str] | None
    user_ids: set[str] | None
    client_ids: set[str] | None

    def allows_repo(self, repo: models.Repo | None) -> bool:
        # Organization-less repositories retain the administration API's
        # existing shared-resource policy. A missing repository is not shared.
        return self.org_ids is None or bool(
            repo is not None and (repo.org_id is None or repo.org_id in self.org_ids))

    def allows_task(self, task: models.Task) -> bool:
        if self.client_ids is None:
            return True
        # Ownerless tasks remain super-administrator-only, as in admin.tasks.
        # Also retain the task's frozen account fence after device account changes.
        return (task.owner_client_id in self.client_ids and
                (not task.owner_user_id or task.owner_user_id in self.user_ids))


async def load(session: AsyncSession, actor: models.User | None = None, *,
               system: bool = False) -> ManagementScope:
    """Require an actor or an explicit scheduler principal; omission is never global."""
    if system == (actor is not None):
        raise ValueError("Supply an administrator or explicitly select the system scheduler")
    if system:
        return ManagementScope(None, None, None)
    org_ids = await rbac.scope_org_ids(session, actor)
    if org_ids is None:
        return ManagementScope(None, None, None)
    user_ids = await rbac.scoped_user_ids(session, org_ids) or set()
    clients = (await session.execute(select(models.Client.id, models.Client.user_ref))).all()
    # Match admin._visible_client_ids: unassigned devices remain manageable;
    # an account lacking an organization does not become an unassigned device.
    client_ids = {cid for cid, uid in clients if uid is None or uid in user_ids}
    return ManagementScope(org_ids, user_ids, client_ids)
