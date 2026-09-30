import { normalizeForMatching } from './text.js';

/*
 * BUILT-IN URGENCY PHRASES (English).
 *
 * !! This list needs review by someone medically and legally qualified before
 * !! real patients use the receptionist. It is a conservative starting point:
 * !! it errs towards treating a call as an emergency, because sending someone
 * !! to emergency services unnecessarily is far cheaper than missing a real one.
 *
 * Phrases are matched as whole words after normalisation (case, punctuation and
 * apostrophes ignored). A phrase in either list applies to every practice and
 * cannot be switched off; practices can only ADD urgent phrases of their own.
 *
 * Known limits: it does not understand negation ("no chest pain") or context,
 * so it may raise a false alarm, never lower a real one; it does not see
 * misspellings beyond the variants listed, other languages, or deliberately
 * obscured wording ("c h e s t"). The AI model is told the same rules, but this
 * check does not depend on the model.
 */

/** A real or possible threat to life or safety. The caller is told the practice's emergency message. */
export const EMERGENCY_PHRASES: readonly string[] = [
  // Breathing and heart
  'chest pain', 'chest pains', 'pain in my chest', 'pressure in my chest', 'heart attack', 'having a heart attack',
  "can't breathe", 'cannot breathe', 'can not breathe', 'cant catch my breath', 'trouble breathing', 'difficulty breathing',
  'hard to breathe', 'struggling to breathe', 'short of breath', 'stopped breathing', 'not breathing', 'gasping for air', 'choking',
  // Brain and consciousness
  'stroke', 'having a stroke', 'face is drooping', 'face drooping', 'slurred speech', 'sudden numbness', 'seizure', 'having a seizure',
  'convulsing', 'unconscious', 'unresponsive', 'passed out', "won't wake up", 'will not wake up', 'not waking up', 'wont wake up', 'cannot wake', 'cant wake',
  // Bleeding and injury
  'severe bleeding', "won't stop bleeding", 'will not stop bleeding', 'wont stop bleeding', 'bleeding heavily', 'bleeding a lot', 'bleeding badly',
  'a lot of blood', 'lot of bleeding',
  'coughing up blood', 'vomiting blood', 'throwing up blood', 'head injury', 'hit their head', 'hit my head',
  // Allergic reaction
  'anaphylaxis', 'anaphylactic', 'throat is closing', 'throat closing', 'throat is swelling', 'swelling in my throat', 'face is swelling',
  // Poisoning and overdose
  'overdose', 'overdosed', 'over dosed', 'took too many pills', 'took too many tablets', 'poisoned', 'swallowed poison', 'drank bleach',
  // Danger to others
  'going to kill', 'kill someone', 'kill him', 'kill her', 'kill them', 'hurt someone', 'going to hurt someone', 'someone is going to hurt me',
  // Pregnancy
  'water broke', 'my water broke', 'in labor', 'in labour', 'baby is not moving', 'baby stopped moving',
  // Plain statements
  'medical emergency', 'this is an emergency', 'its an emergency', 'it is an emergency', 'life threatening', 'life-threatening',
  'call 911', 'dial 911', 'call an ambulance', 'need an ambulance', 'call the ambulance', 'i am dying', 'im dying', 'is dying', 'he is dying', 'she is dying', 'hes dying', 'shes dying', 'theyre dying', 'about to die',
].map(normalizeForMatching);

/**
 * Suicide and self-harm. Also an emergency (staff are alerted, the call is handed
 * over when possible), but the caller hears the practice's CRISIS message (for
 * example the 988 line in the US) instead of, or next to, the medical-emergency
 * message, as a human receptionist would: 911 for a medical emergency, 988 for
 * thoughts of suicide. A call with both kinds of phrase hears both messages.
 */
export const CRISIS_PHRASES: readonly string[] = [
  'suicide', 'suicidal', 'kill myself', 'killing myself', 'end my life', 'ending my life', 'take my own life', 'want to die', 'wanna die',
  "don't want to live", 'dont want to live', 'better off dead', 'hurt myself', 'hurting myself', 'self harm', 'self harming', 'cutting myself',
  'end it all', 'ending it all', 'no reason to live', 'point in living', 'not worth living',
  // Past tense, and a caller describing someone else ("my son says he wants to kill himself")
  'wanted to die', 'wants to die', 'wish i was dead', 'wish i were dead', 'wish i could die', 'rather be dead', 'attempted suicide', 'tried to kill myself',
  'kill himself', 'kill herself', 'kill themselves', 'killing himself', 'killing herself', 'killing themselves',
  'end his life', 'end her life', 'end their life', 'take his own life', 'take her own life', 'take their own life',
  'hurt himself', 'hurt herself', 'hurt themselves', 'hurting himself', 'hurting herself', 'hurting themselves',
].map(normalizeForMatching);

/**
 * Needs a person's attention soon, but is not (yet) an emergency. What happens
 * is the practice's "urgent" setting: hand the call over, alert staff, or both.
 */
export const URGENT_PHRASES: readonly string[] = [
  'high fever', 'very high fever', "fever won't go down", 'fever wont go down', 'fever is not going down', 'temperature is very high',
  'severe pain', 'unbearable pain', 'terrible pain', 'excruciating', 'in a lot of pain', 'pain is getting worse',
  'pain is unbearable', 'pain is severe', 'pain is terrible', 'pain is excruciating', 'pain is really bad', 'pain is very bad', 'in agony',
  'allergic reaction', 'bad reaction', 'reaction to the medication', 'rash is spreading', 'spreading rash',
  'ran out of my medication', 'run out of my medication', 'out of my medication', 'out of my medicine', 'ran out of medication', 'missed my medication',
  'medication is making me', 'side effects are', 'withdrawal',
  'panic attack', 'panic attacks', 'having a panic attack', 'in crisis', 'crisis', 'feeling hopeless', 'hopeless', 'feel unsafe', 'dont feel safe',
  'not safe at home', 'worried about my safety', 'relapse', 'relapsed',
  'getting worse', 'much worse', 'gotten worse', 'urgent', 'urgently', 'its urgent', 'cant wait',
].map(normalizeForMatching);
