# Active Group Call API Documentation

## Endpoint: GET /api/v2/active-group-calls

This endpoint retrieves all active group calls and merges line 1 (call_users) and line 2 (guest_users) data into a unified response structure.

### Request
```
GET /api/v2/active-group-calls
```

### Response Structure

```json
{
  "success": true,
  "count": 2,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "project_id": "507f1f77bcf86cd799439012",
      "start_time": 1706620800000,
      "end_time": 0,
      "updated": 1706620900000,
      "call_type": "video",
      "room_id": "room123",
      "voip_token": "token123",
      "current_status": "active",
      "is_random_call": false,
      "call_mode": "group",
      "chat_room_id": "chat123",
      "chat_room_name": "Team Meeting",
      "is_247_call": false,
      "is_calendar_call": true,
      "sender_user_id": "507f1f77bcf86cd799439013",
      "reciever_user_id": "507f1f77bcf86cd799439014",
      "participants": {
        "line1": [
          {
            "user_id": "507f1f77bcf86cd799439015",
            "device_id": "507f1f77bcf86cd799439016",
            "current_status": "joined",
            "missed_call": false,
            "deleted": 0,
            "created": 1706620800000,
            "updated": 1706620850000,
            "user_type": "registered"
          },
          {
            "user_id": "507f1f77bcf86cd799439017",
            "device_id": "507f1f77bcf86cd799439018",
            "current_status": "joined",
            "missed_call": false,
            "deleted": 0,
            "created": 1706620810000,
            "updated": 1706620860000,
            "user_type": "registered"
          }
        ],
        "line2": [
          {
            "user_name": "Guest User 1",
            "user_type": "guest",
            "current_status": "joined",
            "created": 1706620820000
          },
          {
            "user_name": "Guest User 2",
            "user_type": "guest",
            "current_status": "joined",
            "created": 1706620830000
          }
        ],
        "total_count": 4,
        "line1_count": 2,
        "line2_count": 2,
        "all_users": [
          {
            "user_id": "507f1f77bcf86cd799439015",
            "device_id": "507f1f77bcf86cd799439016",
            "current_status": "joined",
            "missed_call": false,
            "deleted": 0,
            "created": 1706620800000,
            "updated": 1706620850000,
            "user_type": "registered"
          },
          {
            "user_id": "507f1f77bcf86cd799439017",
            "device_id": "507f1f77bcf86cd799439018",
            "current_status": "joined",
            "missed_call": false,
            "deleted": 0,
            "created": 1706620810000,
            "updated": 1706620860000,
            "user_type": "registered"
          },
          {
            "user_name": "Guest User 1",
            "user_type": "guest",
            "current_status": "joined",
            "created": 1706620820000
          },
          {
            "user_name": "Guest User 2",
            "user_type": "guest",
            "current_status": "joined",
            "created": 1706620830000
          }
        ]
      }
    }
  ]
}
```

### Key Features

1. **Line 1 (call_users)**: Contains registered users with full user information including user_id, device_id, and status tracking
2. **Line 2 (guest_users)**: Contains guest users with basic information like user_name and user_type
3. **Merged Participants Object**: 
   - `line1`: Array of registered users
   - `line2`: Array of guest users
   - `total_count`: Total number of participants (line1 + line2)
   - `line1_count`: Number of registered users
   - `line2_count`: Number of guest users
   - `all_users`: Combined array of all participants from both lines

### Filters Applied

- Only returns group calls (`call_mode: 'group'`)
- Excludes ended calls (`current_status != 'ended'`)
- Sorted by start_time (most recent first)
- Limited to 100 most recent active calls

### Error Handling

If an error occurs, the API will return an error response with appropriate HTTP status code and error message.

```json
{
  "error": "Error message description"
}
```
