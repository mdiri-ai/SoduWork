"""Persist whether an automation opens a fresh or reused conversation."""
from alembic import op
import sqlalchemy as sa

revision = "0093_schedule_session_mode"
down_revision = "0092_task_text_storage"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "ai_schedule",
        sa.Column("session_mode", sa.String(length=16), nullable=False,
                  server_default="fresh"),
    )
    # Points at the conversation the next reuse-mode run continues. Empty for
    # fresh schedules and until the first reuse run acknowledges its chat id.
    op.add_column(
        "ai_schedule",
        sa.Column("recurring_conversation_id", sa.String(length=180),
                  nullable=False, server_default=""),
    )


def downgrade():
    op.drop_column("ai_schedule", "recurring_conversation_id")
    op.drop_column("ai_schedule", "session_mode")
