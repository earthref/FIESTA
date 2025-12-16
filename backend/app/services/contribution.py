"""
Service layer for contribution-related operations.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models.contribution import (
    Contribution,
    ContributionHistory,
    ContributionStatus,
)
from app.schemas.data import DataCreate, DataUpdate, DataValidationResult
from app.schemas.token import UserResponse


class ContributionService:
    """Service class for contribution operations."""
    
    @classmethod
    async def create_contribution(
        cls,
        db: AsyncSession,
        data_in: DataCreate,
        repository: str,
        user: UserResponse,
    ) -> Contribution:
        """
        Create a new contribution.
        
        Args:
            db: Database session
            data_in: Input data for the contribution
            repository: Repository name
            user: User creating the contribution
            
        Returns:
            Created contribution
        """
        contribution = Contribution(
            repository=repository,
            data_type=data_in.data_type.value,
            data=data_in.data,
            metadata=data_in.metadata or {},
            created_by=user.id,
            status=ContributionStatus.DRAFT,
            is_public=False,
        )
        
        db.add(contribution)
        await db.flush()
        
        # Create history entry
        history = ContributionHistory(
            contribution_id=contribution.id,
            action="create",
            changes={"status": [None, ContributionStatus.DRAFT.value]},
            user_id=user.id,
        )
        db.add(history)
        
        await db.commit()
        await db.refresh(contribution)
        
        return contribution
    
    @classmethod
    async def update_contribution(
        cls,
        db: AsyncSession,
        contribution_id: int,
        data_in: Union[DataUpdate, Dict[str, Any]],
        user: UserResponse,
    ) -> Optional[Contribution]:
        """
        Update an existing contribution.
        
        Args:
            db: Database session
            contribution_id: ID of the contribution to update
            data_in: Updated data
            user: User making the update
            
        Returns:
            Updated contribution if found, None otherwise
        """
        # Get the contribution with relationships loaded
        stmt = (
            select(Contribution)
            .options(selectinload(Contribution.history))
            .where(Contribution.id == contribution_id)
        )
        result = await db.execute(stmt)
        contribution = result.scalar_one_or_none()
        
        if not contribution:
            return None
        
        # Track changes
        changes = {}
        
        # Update data if provided
        if isinstance(data_in, DataUpdate):
            if data_in.data is not None and data_in.data != contribution.data:
                changes["data"] = [contribution.data, data_in.data]
                contribution.data = data_in.data
            
            if data_in.metadata is not None and data_in.metadata != contribution.metadata:
                changes["metadata"] = [contribution.metadata, data_in.metadata]
                contribution.metadata = data_in.metadata
        elif isinstance(data_in, dict):
            # Handle dictionary updates
            for key, value in data_in.items():
                if hasattr(contribution, key) and getattr(contribution, key) != value:
                    changes[key] = [getattr(contribution, key), value]
                    setattr(contribution, key, value)
        
        # Update timestamps and user
        contribution.updated_by = user.id
        
        # Create history entry if there are changes
        if changes:
            history = ContributionHistory(
                contribution_id=contribution.id,
                action="update",
                changes=changes,
                user_id=user.id,
            )
            db.add(history)
        
        await db.commit()
        await db.refresh(contribution)
        
        return contribution
    
    @classmethod
    async def get_contribution(
        cls,
        db: AsyncSession,
        contribution_id: int,
        include_private: bool = False,
    ) -> Optional[Contribution]:
        """
        Get a contribution by ID.
        
        Args:
            db: Database session
            contribution_id: ID of the contribution to retrieve
            include_private: Whether to include private contributions
            
        Returns:
            Contribution if found and accessible, None otherwise
        """
        stmt = select(Contribution).where(Contribution.id == contribution_id)
        
        if not include_private:
            stmt = stmt.where(Contribution.is_public == True)
        
        result = await db.execute(stmt)
        return result.scalar_one_or_none()
    
    @classmethod
    async def search_contributions(
        cls,
        db: AsyncSession,
        repository: Optional[str] = None,
        data_type: Optional[str] = None,
        status: Optional[str] = None,
        is_public: Optional[bool] = None,
        created_by: Optional[int] = None,
        page: int = 1,
        per_page: int = 10,
    ) -> Tuple[List[Contribution], int]:
        """
        Search for contributions with filtering and pagination.
        
        Args:
            db: Database session
            repository: Filter by repository name
            data_type: Filter by data type
            status: Filter by status
            is_public: Filter by public/private status
            created_by: Filter by creator ID
            page: Page number (1-based)
            per_page: Items per page
            
        Returns:
            Tuple of (list of contributions, total count)
        """
        # Build the base query
        stmt = select(Contribution)
        count_stmt = select(func.count(Contribution.id))
        
        # Apply filters
        conditions = []
        
        if repository is not None:
            conditions.append(Contribution.repository == repository)
        
        if data_type is not None:
            conditions.append(Contribution.data_type == data_type)
        
        if status is not None:
            conditions.append(Contribution.status == status)
        
        if is_public is not None:
            conditions.append(Contribution.is_public == is_public)
        
        if created_by is not None:
            conditions.append(Contribution.created_by == created_by)
        
        if conditions:
            stmt = stmt.where(and_(*conditions))
            count_stmt = count_stmt.where(and_(*conditions))
        
        # Apply pagination
        offset = (page - 1) * per_page
        stmt = stmt.offset(offset).limit(per_page)
        
        # Execute queries
        result = await db.execute(stmt)
        count_result = await db.execute(count_stmt)
        
        return result.scalars().all(), count_result.scalar_one()
    
    @classmethod
    async def validate_contribution_data(
        cls,
        db: AsyncSession,
        data_in: DataCreate,
        repository: str,
    ) -> DataValidationResult:
        """
        Validate contribution data against the schema.
        
        This is a placeholder implementation that should be replaced with
        actual validation logic based on the repository and data type.
        
        Args:
            db: Database session
            data_in: Data to validate
            repository: Repository name
            
        Returns:
            Validation result
        """
        # TODO: Implement actual validation based on repository and data type
        # This is a simplified example
        errors = []
        
        # Example validation: Check required fields
        required_fields = ["id", "name"]
        for field in required_fields:
            if field not in data_in.data:
                errors.append({
                    "field": field,
                    "message": f"Field '{field}' is required",
                })
        
        return DataValidationResult(
            valid=len(errors) == 0,
            errors=errors if errors else None,
            data=data_in.data,
        )
    
    @classmethod
    async def change_contribution_status(
        cls,
        db: AsyncSession,
        contribution_id: int,
        new_status: str,
        user: UserResponse,
        comment: Optional[str] = None,
    ) -> Optional[Contribution]:
        """
        Change the status of a contribution.
        
        Args:
            db: Database session
            contribution_id: ID of the contribution
            new_status: New status
            user: User making the change
            comment: Optional comment for the status change
            
        Returns:
            Updated contribution if found, None otherwise
        """
        # Get the contribution with relationships loaded
        stmt = (
            select(Contribution)
            .options(selectinload(Contribution.history))
            .where(Contribution.id == contribution_id)
        )
        result = await db.execute(stmt)
        contribution = result.scalar_one_or_none()
        
        if not contribution:
            return None
        
        # Update status
        old_status = contribution.status.value if contribution.status else None
        contribution.status = new_status
        
        # Update timestamps for specific status changes
        if new_status == ContributionStatus.PUBLISHED:
            contribution.published_at = datetime.utcnow()
            contribution.is_public = True
        
        # Create history entry
        changes = {"status": [old_status, new_status]}
        if comment:
            changes["comment"] = comment
        
        history = ContributionHistory(
            contribution_id=contribution.id,
            action=f"status_change_to_{new_status}",
            changes=changes,
            user_id=user.id,
        )
        db.add(history)
        
        await db.commit()
        await db.refresh(contribution)
        
        return contribution
