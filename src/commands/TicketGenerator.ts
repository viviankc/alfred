import {
  Client, Message, SlashCommandBuilder, ChatInputCommandInteraction,
} from 'discord.js'
import { Configuration, OpenAIApi } from 'openai'
import { GPT_API_KEY, AlfredGithubConfig } from '../config/config'
import TicketCreatorPrompt from '../prompts/TicketCreatorPrompt'
import openAISettings from '../config/openAISettings'
import { getOctokit, createIssue, getRepositoryLabels } from '../utils/github'
import LabelsPrompt from '../prompts/LabelsPrompt'
import PreConversationPrompt from '../prompts/PreConversationPrompt'
import { getMessageFromURL, mentionUser, replyOrFollowup } from '../utils/discord'
import { AlfredResponse } from '../types/AlfredResponse'

/*  ******SETTINGS****** */
// Number of messages to send to ChatGPT for context
const COUNT_RESPONSE_LIMIT = 4
const USER_WORD_INPUT_LIMIT = 1500
const TIMEOUT_WAITING_FOR_RESPONSE_LIMIT = 30000
const USER_RESPONSE_COUNT_LIMIT = 1

// TEMPORARY SETTINGS
const OWNER = 'viviankc'
const REPO = 'gtc'

const configuration = new Configuration({ apiKey: GPT_API_KEY })
const openai = new OpenAIApi(configuration)
const octokit = getOctokit(AlfredGithubConfig)

async function generateAlfredResponse(conversation: string) {
  if (conversation.trim().length === 0) {
    throw new Error('Please enter valid information or conversation')
  }

  if (conversation.split(' ').length > USER_WORD_INPUT_LIMIT) {
    throw new Error(`
      Not able to review the conversation because it exceeds the 
      word limit of ${USER_WORD_INPUT_LIMIT} (${conversation.split(' ').length} words)
    `)
  }

  const labels = await getRepositoryLabels(await octokit, OWNER, REPO)
  const completion = await openai.createChatCompletion({
    messages: [
      { role: 'system', content: `${TicketCreatorPrompt}` },
      { role: 'system', content: `${LabelsPrompt}` },
      { role: 'system', content: `${labels}` },
      { role: 'system', content: `${PreConversationPrompt}` },
      { role: 'user', content: `${conversation}` },
    ],
    ...openAISettings,
  } as any)
  const alfredResponse = completion.data.choices[0].message?.content.toString()

  if (alfredResponse) {
    return JSON.parse(alfredResponse) as AlfredResponse
  } else {
    throw new Error ('GPT response is unfortunately empty. Troubled servers perhaps?')
  }
}

const generateTicketCommandData = new SlashCommandBuilder()
  .setName('create-issue-ai')
  .setDescription('Alfred will read conversation and create a ticket')
  .addStringOption((option) => option
    .setName('first_message')
    .setDescription('URL of the first message Alfred should start from')
    .setRequired(true))

// Command to generate a GitHub Ticket
export default {
  data: generateTicketCommandData,
  execute: async (client: Client, interaction: ChatInputCommandInteraction) => {
    let responseCount: number = 0

    // Get the first message to start from (the Original Post)
    const op = await getMessageFromURL(client, interaction.options.getString('first_message'))

    // Find the channel where the conversation took place
    const channel = await client.channels.cache.get(interaction.channelId)

    if (channel && channel.isTextBased()) {
      // Start the conversation with the OP
      let conversation = `${op.author.username} : ${op.content} \n`

      // Fetch the messages in the channel after OP and concatenate them
      const messages = await channel.messages.fetch({ after: op.id })
      messages.reverse().forEach((message: Message<true> | Message<false>) => {
        conversation += `${message.author.username} : ${message.content} \n`
      })

      // Pass the messages from Discord to GPT model to create a response
      let alfredResponse = await generateAlfredResponse(conversation)

      // If additional information is required from the user, Alfred will ask
      // some questions to the user before creating the ticket, up to a point.
      while (alfredResponse.response_to_user !== 'I have all the information needed!' && responseCount < COUNT_RESPONSE_LIMIT) {
        await replyOrFollowup(
          interaction,
          responseCount > 1,
          { 
            ephemeral: true,
            content:`${mentionUser(interaction.user.id)} ${alfredResponse.response_to_user}`
          }
        )

        // Listen for user response
        const responseMessage = await channel.awaitMessages({
          filter: (m: any) => m.author.id === interaction.user.id && m.channel.id === channel.id,
          max: USER_RESPONSE_COUNT_LIMIT,
          time: TIMEOUT_WAITING_FOR_RESPONSE_LIMIT,
        })

        if (responseMessage.size === 0) {
          throw new Error('The waiting period for the response has timed out.')
        }

        // Append new response from user to conversation sent to GPT
        const userResponse = responseMessage?.first()?.content || ''
        conversation += `${responseMessage?.first()?.author.username || 'User response'}: ${userResponse} `

        alfredResponse = await generateAlfredResponse(conversation)
        responseCount += 1
      }

      // Create github ticket using alfred's response
      const url = await createIssue(
        await octokit,
        OWNER,
        REPO,
        alfredResponse.title,
        alfredResponse.body,
        alfredResponse.labels,
      )

      await replyOrFollowup(
        interaction,
        responseCount > 1,
        { 
          ephemeral: true,
          content:
            `**${alfredResponse.title}**\n`
            + `:link: ${url}\n`
            + `:label: ${alfredResponse.labels}\n`
            + `\`\`\`${alfredResponse.body}\`\`\``,
        }
      )
    }
  },
}
