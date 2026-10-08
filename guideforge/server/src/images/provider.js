/**
 * Future image-generation provider hook.
 * V1 only plans prompts; generation can be plugged in later.
 */
export const imageProvider = {
  async generate({ prompt, aspectRatio, metadata }) {
    void prompt;
    void aspectRatio;
    void metadata;
    return {
      status: "not_implemented",
      message: "Image generation provider not configured. Use planned prompts.",
    };
  },
};
