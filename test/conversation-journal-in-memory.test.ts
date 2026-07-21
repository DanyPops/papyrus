import { InMemoryConversationJournalStore } from "../src/adapters/in-memory-conversation-journal-store.ts";
import { ConversationJournalService } from "../src/conversation-journal-service.ts";
import { conversationJournalConformanceSuite } from "./conversation-journal-conformance.ts";

conversationJournalConformanceSuite(() => new ConversationJournalService(new InMemoryConversationJournalStore()));
