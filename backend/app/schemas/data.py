"""
Pydantic schemas for data operations.
"""
from typing import Any, Dict, List, Optional, Union
from enum import Enum
from datetime import datetime
from pydantic import BaseModel, Field, HttpUrl


class RepositoryEnum(str, Enum):
    """Supported repositories."""
    MAGIC = "MagIC"


class DataType(str, Enum):
    """Data types for contributions."""
    SAMPLE = "sample"
    SITE = "site"
    LOCATION = "location"
    # Add more data types as needed


class DataResponse(BaseModel):
    """Base response for data operations."""
    success: bool = Field(..., description="Whether the operation was successful")
    message: Optional[str] = Field(None, description="Optional message")
    data: Optional[Dict[str, Any]] = Field(None, description="Response data")


class DataCreate(BaseModel):
    """Schema for creating new data."""
    data: Dict[str, Any] = Field(..., description="The data to store")
    data_type: DataType = Field(..., description="Type of the data")
    metadata: Optional[Dict[str, Any]] = Field(
        None, description="Additional metadata"
    )


class DataUpdate(BaseModel):
    """Schema for updating existing data."""
    data: Dict[str, Any] = Field(..., description="The updated data")
    metadata: Optional[Dict[str, Any]] = Field(
        None, description="Updated metadata"
    )


class DataInDB(BaseModel):
    """Schema for data in the database."""
    id: int = Field(..., description="Unique identifier")
    repository: str = Field(..., description="Repository name")
    data_type: str = Field(..., description="Type of the data")
    data: Dict[str, Any] = Field(..., description="The actual data")
    metadata: Dict[str, Any] = Field(
        default_factory=dict, description="Additional metadata"
    )
    created_by: Optional[int] = Field(
        None, description="ID of the user who created this data"
    )
    created_at: datetime = Field(..., description="Creation timestamp")
    updated_at: Optional[datetime] = Field(
        None, description="Last update timestamp"
    )

    class Config:
        orm_mode = True


class DataSearchResult(BaseModel):
    """Schema for search results."""
    total: int = Field(..., description="Total number of results")
    items: List[DataInDB] = Field(..., description="List of matching items")
    aggregations: Optional[Dict[str, Any]] = Field(
        None, description="Aggregation results if any"
    )


class DataValidationResult(BaseModel):
    """Schema for validation results."""
    valid: bool = Field(..., description="Whether the data is valid")
    errors: Optional[List[Dict[str, Any]]] = Field(
        None, description="List of validation errors if any"
    )
    warnings: Optional[List[Dict[str, Any]]] = Field(
        None, description="List of validation warnings if any"
    )
    data: Optional[Dict[str, Any]] = Field(
        None, description="Processed data if validation was successful"
    )
