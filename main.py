from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
import os
import json
import uvicorn

# Create FastAPI app
app = FastAPI()

# Configure CORS - read origins from environment or use defaults
origins = os.getenv("CORS_ALLOW_ORIGIN", "https://app.isyncso.com").split(",")
if origins == [""]:
    origins = ["https://app.isyncso.com"]  # Fallback

# Ensure we have the correct headers
allowed_headers = os.getenv("CORS_ALLOW_HEADERS", "Content-Type,Authorization,X-Api-Key,X-Requested-With,Accept,Origin").split(",")
allowed_methods = os.getenv("CORS_ALLOW_METHODS", "GET,POST,PUT,DELETE,OPTIONS").split(",")

print(f"CORS Configuration:")
print(f"  Origins: {origins}")
print(f"  Headers: {allowed_headers}")
print(f"  Methods: {allowed_methods}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=allowed_methods,
    allow_headers=allowed_headers,
    expose_headers=["Content-Type", "Authorization"],
)

# Current health endpoint that's working
@app.get("/health")
async def health_check():
    print(f"Health check requested")
    return {"status": "ok"}

# Add the missing agent/dispatch endpoint
@app.post("/agent/dispatch")
async def agent_dispatch(request: Request):
    print(f"POST /agent/dispatch received")
    try:
        # Get request body if any
        body = await request.json()
        print(f"Request body: {json.dumps(body)}")
    except Exception as e:
        print(f"Error parsing request body: {str(e)}")
        body = {}
    
    # Simple mock response
    return {
        "status": "success",
        "message": "Agent dispatched successfully",
        "data": {
            "agent_id": "mock-agent-123",
            "connection_info": {
                "token": "mock-token-xyz",
                "room": "mock-room-456"
            }
        }
    }

# Also handle OPTIONS requests explicitly for CORS preflight
@app.options("/agent/dispatch")
async def agent_dispatch_options():
    print(f"OPTIONS /agent/dispatch received")
    origin = origins[0] if origins else "https://app.isyncso.com"
    headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Requested-With, Accept, Origin",
        "Access-Control-Allow-Credentials": "true",
    }
    print(f"Responding with headers: {headers}")
    return Response(
        status_code=200,
        headers=headers
    )

# Add other needed endpoints here
@app.get("/agent/token")
async def agent_token():
    print(f"GET /agent/token received")
    return {
        "token": "mock-token-abc-123",
        "expires_at": "2025-05-16T00:00:00Z"
    }

if __name__ == "__main__":
    # Get port from environment variable or default to the one used by FastAPI
    port = int(os.environ.get("PORT", 8000))
    print(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port) 