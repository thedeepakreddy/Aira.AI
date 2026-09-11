"""Real browser-use client against the local no-cost gateway fixture."""
import asyncio
import sys

from browser_use import ChatOpenAI
from browser_use.llm.messages import ContentPartImageParam, ContentPartTextParam, ImageURL, UserMessage
from pydantic import BaseModel


class BrowserAction(BaseModel):
    done: bool
    summary: str


async def main() -> None:
    client = ChatOpenAI(
        model="aira-offline-model",
        base_url=f"{sys.argv[1]}/openai/task/v1",
        api_key="offline-fixture",
        frequency_penalty=None,
        default_headers={"X-Aira-Memory": "off"},
        max_retries=0,
    )
    result = await client.ainvoke(
        [UserMessage(content=[
            ContentPartTextParam(text="Inspect this test screenshot."),
            ContentPartImageParam(image_url=ImageURL(url="data:image/png;base64,YQ==")),
        ])],
        output_format=BrowserAction,
    )
    assert result.completion.done is True
    assert result.completion.summary == "AIRA_BROWSER_CLIENT_PASSED"
    assert result.usage is not None and result.usage.total_tokens == 10
    print("AIRA_BROWSER_CLIENT_PASSED")


asyncio.run(main())
