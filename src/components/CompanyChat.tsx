/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
import { Upload, Mail, X, Trash2 } from 'lucide-react';

import {
  Message,
  ConversationSettings,
  DEFAULT_CONVERSATION_SETTINGS,
  CompanyDocument
} from '../types';
import { subscribeToMessages, addMessage, subscribeToCompany, updateCompanySettings, addCompanyMember, addCompanyDocument, subscribeToCompanyDocuments } from '../services/firestore';
import { generateAIResponse } from '../services/mockAI';
import { generateAvatarVideo, GooeyVideoResponse } from '../services/gooey';
import { speakText, stopSpeaking } from '../services/tts';
import { queryDocuments, upsertDocuments } from '../services/pinecone';
import { subscribeToCompanyMembers, addCompanyMemberToFirestore, removeCompanyMember, ensureCompanyOwner, CompanyMember } from '../services/companyMembers';
import { extractTextFromPDF } from '../services/pdfParser';
import { useAuth } from '../contexts/AuthContext';
import AvatarSettingsPanel from './AvatarSettingsPanel';
import VideoPlayer, { VideoState } from './VideoPlayer';
import ChatHeader from './ChatHeader';
import TranscriptView from './TranscriptView';
import MessageInput from './MessageInput';

interface CompanyChatProps {
  companyId: string;
}

export default function CompanyChat({ companyId }: CompanyChatProps) {
  const { currentUser } = useAuth();
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentContext, setAttachmentContext] = useState<string>('');
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [videoState, setVideoState] = useState<VideoState>('idle');
  const [currentCaption, setCurrentCaption] = useState<string>('');
  const [currentVideoUrl, setCurrentVideoUrl] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showDocumentUpload, setShowDocumentUpload] = useState(false);
  const [settings, setSettings] = useState<ConversationSettings>(DEFAULT_CONVERSATION_SETTINGS);
  const [gooeyResponse, setGooeyResponse] = useState<GooeyVideoResponse | null>(null);
  const [companyDocuments, setCompanyDocuments] = useState<CompanyDocument[]>([]);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentContent, setDocumentContent] = useState('');
  const [rawPdfContent, setRawPdfContent] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isProcessingPdf, setIsProcessingPdf] = useState(false);
  const [transcriptHeight, setTranscriptHeight] = useState(300);

  useEffect(() => {
    stopSpeaking();
    setMessages([]);
    setInput('');
    setVideoState('idle');
    setCurrentCaption('');
    setCurrentVideoUrl(null);
    setGooeyResponse(null);
    setSettings(DEFAULT_CONVERSATION_SETTINGS);

    const conversationId = `company_${companyId}`;
    const unsubscribeMessages = subscribeToMessages(conversationId, setMessages);

    const unsubscribeCompany = subscribeToCompany(companyId, (company) => {
      if (company) {
        setSettings(company.settings || DEFAULT_CONVERSATION_SETTINGS);
      }
    });

    const unsubscribeDocs = subscribeToCompanyDocuments(companyId, setCompanyDocuments);

    const unsubscribeMembers = subscribeToCompanyMembers(companyId, setCompanyMembers);

    if (currentUser?.email) {
      ensureCompanyOwner(companyId, currentUser.email).catch(console.error);
    }

    return () => {
      unsubscribeMessages();
      unsubscribeCompany();
      unsubscribeDocs();
      unsubscribeMembers();
      stopSpeaking();
    };
  }, [companyId, currentUser?.email]);

  const handleSendWithText = useCallback(async (text: string) => {
    if (!text.trim() || videoState === 'thinking' || videoState === 'speaking') return;

    const userMessage = text.trim();
    const conversationId = `company_${companyId}`;
    const currentAttachmentContext = attachmentContext;

    setInput('');
    setVideoState('thinking');
    setCurrentVideoUrl(null);
    setGooeyResponse(null);

    try {
      const userMessageWithContext = currentAttachmentContext
        ? `${userMessage}\n\n[Attachment Context]:\n${currentAttachmentContext}`
        : userMessage;

      await addMessage({
        conversationId,
        sender: 'user',
        text: userMessageWithContext,
        createdAt: new Date()
      });

      let documentContext = '';
      try {
        const relevantDocs = await queryDocuments(companyId, userMessage, 5);
        if (relevantDocs.length > 0) {
          documentContext = `\n\n[COMPANY KNOWLEDGE BASE - Retrieved from Vector Database]\n${relevantDocs.map((doc, i) =>
            `Document ${i + 1} (Relevance: ${(doc.score * 100).toFixed(1)}%):\n${doc.text}\n---`
          ).join('\n')}`;
          console.log(`Retrieved ${relevantDocs.length} relevant documents from Pinecone for RAG`);
        } else {
          console.log('No relevant documents found in Pinecone');
        }
      } catch (error) {
        console.error('Pinecone query error:', error);
        if (companyDocuments.length > 0) {
          documentContext = `\n\n[COMPANY KNOWLEDGE BASE - Fallback]\n${companyDocuments.map(doc =>
            `${doc.title}:\n${doc.content}\n---`
          ).join('\n')}`;
        }
      }

      const systemContext = documentContext
        ? `You are an AI assistant with access to the company's knowledge base. Use the following relevant documents to answer the user's question accurately. If the answer is not in the documents, say so clearly.${documentContext}`
        : '';

      const enhancedUserMessage = systemContext
        ? `${systemContext}\n\n[USER QUESTION]\n${userMessage}`
        : userMessage;

      const responseText = await generateAIResponse(
        enhancedUserMessage,
        settings,
        messages
      );

      setCurrentCaption(responseText);

      function prepareTextForVideo(text: string): string {
        const cleaned = text.replace(/\s+/g, ' ').replace(/\n/g, ' ').trim();
        if (!/[.!?।]$/.test(cleaned)) {
          return cleaned + '।';
        }
        return cleaned;
      }

      const safeText = prepareTextForVideo(responseText);

      const gooeyResponseResult = await generateAvatarVideo({
        text: safeText,
        language: settings.language,
        avatarUrl: settings.avatarMediaUrl,
        gender: settings.avatarVoiceGender
      });

      setGooeyResponse(gooeyResponseResult);

      await addMessage({
        conversationId,
        sender: 'ai',
        text: responseText,
        transcript: responseText,
        videoUrl: gooeyResponseResult.videoUrl,
        videoUrls: gooeyResponseResult.videoUrls,
        createdAt: new Date()
      });

      setAttachments([]);
      setAttachmentContext('');

      if (gooeyResponseResult.success && (gooeyResponseResult.videoUrls?.length || gooeyResponseResult.videoUrl)) {
        if (gooeyResponseResult.videoUrl) setCurrentVideoUrl(gooeyResponseResult.videoUrl);
        setVideoState('speaking');
      } else {
        setVideoState('speaking');
        await speakText(responseText, settings.tone, undefined, () => {
          setVideoState('idle');
          setCurrentCaption('');
          setCurrentVideoUrl(null);
          setGooeyResponse(null);
        });
      }

    } catch (error) {
      console.error('Failed to send message:', error);
      setVideoState('idle');
      setCurrentCaption('');
      setCurrentVideoUrl(null);
      setGooeyResponse(null);
    }
  }, [videoState, settings, attachmentContext, companyDocuments, companyId, messages]);

  async function handleSend() {
    await handleSendWithText(input);
  }

  function handleVideoEnded() {
    setTimeout(() => {
      setVideoState('idle');
      setCurrentCaption('');
      setCurrentVideoUrl(null);
      setGooeyResponse(null);
    }, 700);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function removeAttachment(index: number) {
    setAttachments(prev => prev.filter((_, i) => i !== index));
    setAttachmentContext('');
  }

  async function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (files.length + attachments.length > 5) {
      alert('You can upload a maximum of 5 attachments.');
      return;
    }
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        alert(`${file.name} exceeds 5MB limit`);
        return;
      }
    }
    setAttachments(prev => [...prev, ...files]);
    await processAttachments(files);
    e.target.value = '';
  }

  async function processAttachments(files: File[]) {
    setIsProcessingAttachments(true);
    try {
      const extractedResults: string[] = [];
      for (const file of files) {
        const base64 = await fileToBase64(file);
        const result = await extractAttachmentWithGemini(file.type, base64);
        extractedResults.push(result);
      }
      const combinedContext = extractedResults.join('\n\n');
      setAttachmentContext(prev => prev ? `${prev}\n\n${combinedContext}` : combinedContext);
    } catch (err) {
      console.error('Attachment extraction failed:', err);
    } finally {
      setIsProcessingAttachments(false);
    }
  }

  async function extractAttachmentWithGemini(mimeType: string, base64Data: string): Promise<string> {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    const body = {
      contents: [{
        parts: [
          { text: `You are a document analysis and information extraction assistant. Extract ALL meaningful information from the attached file.` },
          { inlineData: { mimeType, data: base64Data } }
        ]
      }],
      generationConfig: { temperature: 0.2, topK: 32, topP: 0.9, maxOutputTokens: 4096 }
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No extractable content found.';
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleSettingsChange(newSettings: ConversationSettings) {
    setSettings(newSettings);
    try {
      await updateCompanySettings(companyId, newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  function handlePlayMessage(videoUrl: string | undefined, videoUrls: string[] | undefined, transcript: string) {
    setCurrentCaption(transcript);
    setCurrentVideoUrl(videoUrl || null);
    setGooeyResponse(videoUrls ? { success: true, videoUrls } : null);
    setVideoState('speaking');
  }

  async function handleInvite() {
    const email = inviteEmail.trim();
    if (!email) return;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('Please enter a valid email address');
      return;
    }

    if (!currentUser?.email) {
      alert('You must be logged in to add members');
      return;
    }

    try {
      await addCompanyMemberToFirestore(companyId, email, 'member', currentUser.email);
      await addCompanyMember(companyId, email);
      setInviteEmail('');
      alert(`${email} has been added to the company`);
    } catch (error) {
      console.error('Failed to add member:', error);
      alert('Failed to add member');
    }
  }

  async function handleRemoveMember(memberId: string) {
    if (!confirm('Are you sure you want to remove this member?')) return;

    try {
      await removeCompanyMember(memberId);
    } catch (error) {
      console.error('Failed to remove member:', error);
      alert('Failed to remove member');
    }
  }

  function formatPdfContentForDisplay(rawText: string): string {
    // Clean up and format the text for better readability
    let formatted = rawText
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();

    const sentences = formatted.split(/(?<=[.!?])\s+/);
    const paragraphs: string[] = [];
    let currentParagraph: string[] = [];

    sentences.forEach((sentence, index) => {
      currentParagraph.push(sentence);

      if (currentParagraph.length >= 4 || index === sentences.length - 1) {
        paragraphs.push(currentParagraph.join(' '));
        currentParagraph = [];
      }
    });

    return paragraphs.join('\n\n');
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      alert('Please upload a PDF file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      alert('PDF file size must be less than 10MB');
      return;
    }

    setPdfFile(file);
    setIsProcessingPdf(true);

    try {
      const extractedText = await extractTextFromPDF(file);
      setRawPdfContent(extractedText);
      const formattedText = formatPdfContentForDisplay(extractedText);
      setDocumentContent(formattedText);
      setDocumentTitle(file.name.replace('.pdf', ''));
    } catch (error) {
      console.error('Failed to process PDF:', error);
      alert('Failed to process PDF file');
      setPdfFile(null);
      setRawPdfContent('');
    } finally {
      setIsProcessingPdf(false);
    }
  }

  async function handleDocumentUpload() {
    if (!documentTitle.trim() || !documentContent.trim()) return;
    try {
      const docId = `${companyId}_${Date.now()}`;

      // Use formatted content for Firestore display
      await addCompanyDocument({
        companyId,
        title: documentTitle.trim(),
        content: documentContent.trim(),
        uploadedBy: 'current-user',
        createdAt: new Date()
      });

      // Use raw PDF content for RAG if available, otherwise use the display content
      const contentForRag = rawPdfContent || documentContent.trim();

      try {
        await upsertDocuments(companyId, [
          {
            id: docId,
            text: `${documentTitle.trim()}\n\n${contentForRag}`,
            metadata: {
              title: documentTitle.trim(),
              uploadedBy: 'current-user',
              uploadedAt: new Date().toISOString(),
              source: rawPdfContent ? 'pdf' : 'manual'
            }
          }
        ]);
        console.log('Document indexed to Pinecone successfully');
      } catch (pineconeError) {
        console.error('Failed to index to Pinecone:', pineconeError);
      }

      setDocumentTitle('');
      setDocumentContent('');
      setRawPdfContent('');
      setPdfFile(null);
      setShowDocumentUpload(false);
      alert('Document added and indexed successfully');
    } catch (error) {
      console.error('Failed to upload document:', error);
      alert('Failed to upload document');
    }
  }

  const isBusy = videoState === 'thinking' || videoState === 'speaking';

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-900 overflow-hidden relative z-10">
      <ChatHeader
        settings={settings}
        onSettingsClick={() => setShowSettings(true)}
        onInviteClick={() => setShowInviteModal(true)}
        showInviteButton={true}
        onRagClick={() => setShowDocumentUpload(true)}
        showRagButton={true}
      />

      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col overflow-y-auto min-h-0">
          <div className="flex-shrink-0 p-2 sm:p-3">
            <div className="max-w-full md:max-w-xl mx-auto">
              <VideoPlayer
                state={videoState}
                avatarImageUrl={settings.avatarPreviewImageUrl}
                speakingVideoUrl={currentVideoUrl}
                speakingVideoUrls={gooeyResponse?.videoUrls}
                caption={currentCaption}
                onVideoEnded={handleVideoEnded}
              />
            </div>
          </div>

          <div className="flex-shrink-0">
            <TranscriptView
              messages={messages}
              onPlayMessage={handlePlayMessage}
              transcriptHeight={transcriptHeight}
              onHeightChange={setTranscriptHeight}
            />
          </div>
        </div>

        <div className="flex-shrink-0 z-10 glass-darker border-t border-cyan-500/20">
          <MessageInput
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            isListening={false}
            onToggleListening={() => {}}
            isBusy={isBusy}
            speechError={speechError}
            attachments={attachments}
            onAttachmentSelect={handleAttachmentSelect}
            onRemoveAttachment={removeAttachment}
            isProcessingAttachments={isProcessingAttachments}
          />
        </div>
      </div>

      {showSettings && (
        <AvatarSettingsPanel
          conversationId={companyId}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-scale-in">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setShowInviteModal(false)} />
          <div className="relative w-full max-w-md glass-darker border border-cyan-500/30 rounded-3xl shadow-2xl p-6 sm:p-8 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white heading-font">Team Members</h3>
              <button
                onClick={() => setShowInviteModal(false)}
                className="p-2 hover:bg-cyan-500/20 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-cyan-400 mb-2 heading-font">Add New Member</label>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                    placeholder="colleague@company.com"
                    className="flex-1 px-4 py-3.5 glass-effect border border-cyan-500/20 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-all"
                  />
                  <button
                    onClick={handleInvite}
                    disabled={!inviteEmail.trim()}
                    className="px-4 py-3.5 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-xl hover:neon-glow transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-medium"
                  >
                    <Mail className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {companyMembers.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-cyan-400 mb-3 heading-font">Current Members</label>
                  <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
                    {companyMembers.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3 glass-effect border border-cyan-500/10 rounded-xl hover:border-cyan-500/30 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white truncate">
                            {member.email}
                            {member.email === currentUser?.email && (
                              <span className="ml-2 text-xs text-slate-400">(you)</span>
                            )}
                          </p>
                          <p className="text-xs text-slate-400 capitalize">{member.role}</p>
                        </div>
                        {member.role !== 'owner' && member.email !== currentUser?.email && (
                          <button
                            onClick={() => handleRemoveMember(member.id)}
                            className="p-2 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
                            title="Remove member"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showDocumentUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-scale-in">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => {
            setShowDocumentUpload(false);
            setPdfFile(null);
            setRawPdfContent('');
            setDocumentTitle('');
            setDocumentContent('');
          }} />
          <div className="relative w-full max-w-2xl glass-darker border border-cyan-500/30 rounded-3xl shadow-2xl p-6 sm:p-8 animate-slide-up max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-white heading-font">Add Company Data</h3>
              <button
                onClick={() => {
                  setShowDocumentUpload(false);
                  setPdfFile(null);
                  setRawPdfContent('');
                  setDocumentTitle('');
                  setDocumentContent('');
                }}
                className="p-2 hover:bg-cyan-500/20 rounded-full transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-cyan-400 mb-2 heading-font">Upload PDF Document</label>
                <div className="relative">
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={handlePdfUpload}
                    disabled={isProcessingPdf}
                    className="w-full px-4 py-3.5 glass-effect border border-cyan-500/20 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-all file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-gradient-to-r file:from-cyan-500 file:to-blue-500 file:text-white hover:file:opacity-90 file:cursor-pointer"
                  />
                  {isProcessingPdf && (
                    <div className="absolute right-3 top-3">
                      <div className="animate-spin h-5 w-5 border-2 border-cyan-500 border-t-transparent rounded-full"></div>
                    </div>
                  )}
                </div>
                {pdfFile && !isProcessingPdf && (
                  <div className="mt-2 p-3 glass-effect border border-green-500/30 rounded-lg">
                    <p className="text-xs text-green-400 font-medium">✓ PDF loaded: {pdfFile.name}</p>
                    <p className="text-xs text-green-300 mt-1">Content extracted and ready to upload. You can edit the text below if needed.</p>
                  </div>
                )}
                {!pdfFile && (
                  <p className="text-xs text-slate-400 mt-1">Or manually enter document details below</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-cyan-400 mb-2 heading-font">Document Title</label>
                <input
                  type="text"
                  value={documentTitle}
                  onChange={(e) => setDocumentTitle(e.target.value)}
                  placeholder="Company Policy"
                  className="w-full px-4 py-3.5 glass-effect border border-cyan-500/20 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-all"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-cyan-400 mb-2 heading-font">
                  Content
                  {pdfFile && <span className="text-xs text-slate-400 ml-2">(Formatted for readability - raw PDF data will be used for RAG)</span>}
                </label>
                <textarea
                  value={documentContent}
                  onChange={(e) => setDocumentContent(e.target.value)}
                  rows={10}
                  placeholder="Enter document content here..."
                  className="w-full px-4 py-3.5 glass-effect border border-cyan-500/20 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/50 transition-all scrollbar-thin"
                />
              </div>
              <button
                onClick={handleDocumentUpload}
                disabled={!documentTitle.trim() || !documentContent.trim() || isProcessingPdf}
                className="w-full py-3.5 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-xl hover:neon-glow transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 hover:scale-105 ripple font-medium heading-font"
              >
                <Upload className="w-4 h-4" />
                Upload Document
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
