"""
Contribution database model.
"""
from datetime import datetime
from enum import Enum as EnumType
from typing import Dict, List, Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Table,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.db.base import BaseModel


class ContributionStatus(str, EnumType):
    """Status of a contribution."""
    DRAFT = "draft"
    SUBMITTED = "submitted"
    PUBLISHED = "published"
    REJECTED = "rejected"
    ARCHIVED = "archived"


class Contribution(BaseModel):
    """Contribution model for storing data contributions."""
    __tablename__ = "contributions"
    
    id = Column(Integer, primary_key=True, index=True)
    repository = Column(String(50), nullable=False, index=True)
    data_type = Column(String(50), nullable=False, index=True)
    version = Column(String(20), default="1.0.0")
    
    # Data storage
    data = Column(JSONB, nullable=False)
    metadata = Column(JSONB, default=dict)
    
    # Status and ownership
    status = Column(Enum(ContributionStatus), default=ContributionStatus.DRAFT)
    is_public = Column(Boolean, default=False, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    
    # Timestamps
    published_at = Column(DateTime, nullable=True)
    
    # Relationships
    creator = relationship("User", foreign_keys=[created_by])
    updater = relationship("User", foreign_keys=[updated_by])
    
    def __repr__(self):
        return f"<Contribution {self.id} ({self.repository}/{self.data_type})>"
    
    def to_dict(self, include_relationships: bool = False) -> Dict:
        """Convert contribution to dictionary."""
        result = {
            "id": self.id,
            "repository": self.repository,
            "data_type": self.data_type,
            "version": self.version,
            "status": self.status.value,
            "is_public": self.is_public,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "published_at": self.published_at.isoformat() if self.published_at else None,
            "created_by": self.created_by,
            "updated_by": self.updated_by,
            "data": self.data,
            "metadata": self.metadata or {},
        }
        
        if include_relationships and self.creator:
            result["creator"] = self.creator.to_dict()
            
        if include_relationships and self.updater:
            result["updater"] = self.updater.to_dict()
            
        return result


class ContributionHistory(BaseModel):
    """Audit history for contributions."""
    __tablename__ = "contribution_history"
    
    id = Column(Integer, primary_key=True)
    contribution_id = Column(Integer, ForeignKey("contributions.id"), nullable=False)
    
    # What changed
    action = Column(String(50), nullable=False)  # create, update, status_change, etc.
    changes = Column(JSONB, default=dict)  # {field: [old_value, new_value]}
    
    # Who made the change
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    # Relationships
    contribution = relationship("Contribution", back_populates="history")
    user = relationship("User")
    
    def __repr__(self):
        return f"<ContributionHistory {self.id} ({self.action} on {self.contribution_id})>"


# Add relationship to Contribution model
Contribution.history = relationship(
    "ContributionHistory",
    order_by=ContributionHistory.created_at,
    back_populates="contribution",
    cascade="all, delete-orphan",
)
