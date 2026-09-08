export const CambridgeSelectors = {
  activityRoot: "#activity",
  activityIframe: 'iframe[title^="Activity:"]',
  activeScreen: ".content-wrap:not(.activity--hidden)",
  progressBar: ".progress-bar",
  currentStepNumber: "li.step.current .step-number",
  currentStep: "li.step.current",
  allSteps: "li.step",
  interaction: ".interaction",
  radioInteraction: ".interaction.is-radiobutton",
  checkboxInteraction: ".interaction.is-checkbox",
  dropdownInteraction: ".interaction.is-dropdown",
  gapMatchInteraction: ".interaction.drag-drop",
  textInputInteraction: ".interaction.ic-text-gap",
  radios: '[role="radio"]',
  checkboxes: '[role="checkbox"]',
  comboboxes: '[role="combobox"]',
  options: '[role="option"]',
  selected: '[aria-checked="true"], [aria-selected="true"]',
  // Restrict evaluated values to Cambridge answer roles. Video accessibility
  // controls can also expose aria-selected and are not answers.
  evaluatedChoice: '[role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"], [role="option"][aria-selected="true"], [role="radio"].checked-correct, [role="checkbox"].checked-correct, [role="option"].checked-correct',
  noMoreChoices: ".no-more-choices",
  gapTargets: ".drop_area.gap_match_gap_view",
  textInputs: '.input-text input[type="text"], input[type="text"]',
  filledGap: ".drop_area.gap_match_gap_view.has_drag",
  poolResponses: ".wordpool li.gap_match_gap_text_view.has_drag .drag_element",
  measurementClone: ".width-measure"
  ,checkButtons: '.controls-wrapper a.btn.green-btn[title="Check"], .controls-wrapper [title="Check"], .controls-wrapper .btn-check'
  ,feedbackPanel: "#feedback-panel"
  ,corrected: ".status-corrected"
  ,resultScreen: ".result-screen-wrapper, .tryAgain-btn"
  ,nextButtons: '.controls-wrapper a, .controls-wrapper button'
} as const;
