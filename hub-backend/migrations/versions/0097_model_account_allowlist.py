"""Add the per-model account allowlist used by model admission."""
from alembic import op
import sqlalchemy as sa


revision = "0097_model_account_allowlist"
down_revision = "0093_schedule_session_mode"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "model_def",
        sa.Column("allowed_user_ids", sa.JSON(), nullable=False,
                  server_default=sa.text("'[]'")),
    )


def downgrade() -> None:
    op.drop_column("model_def", "allowed_user_ids")
